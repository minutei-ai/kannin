use serde_json::Number;
use std::cmp::Ordering;

fn integer(number: &Number) -> Option<i128> {
    number
        .as_i64()
        .map(i128::from)
        .or_else(|| number.as_u64().map(i128::from))
}

pub(super) fn compare(left: &Number, right: &Number) -> Option<Ordering> {
    match (integer(left), integer(right)) {
        (Some(left), Some(right)) => Some(left.cmp(&right)),
        (Some(left), None) => compare_integer_float(left, right.as_f64()?),
        (None, Some(right)) => compare_integer_float(right, left.as_f64()?).map(Ordering::reverse),
        (None, None) => left.as_f64()?.partial_cmp(&right.as_f64()?),
    }
}

fn compare_integer_float(integer: i128, floating: f64) -> Option<Ordering> {
    if !floating.is_finite() {
        return None;
    }
    if floating == 0.0 {
        return Some(integer.cmp(&0));
    }
    match (integer.is_negative(), floating.is_sign_negative()) {
        (true, false) => Some(Ordering::Less),
        (false, true) => Some(Ordering::Greater),
        (negative, _) => {
            let magnitude = u64::try_from(integer.unsigned_abs()).ok()?;
            let ordering = compare_magnitudes(magnitude, floating.abs())?;
            Some(if negative {
                ordering.reverse()
            } else {
                ordering
            })
        }
    }
}

#[doc = "Compares a u64 magnitude with a finite, positive, nonzero float by its binary exponent and significand, without rounding the integer into floating point."]
fn compare_magnitudes(integer: u64, floating: f64) -> Option<Ordering> {
    let bits = floating.to_bits();
    let exponent = (bits >> 52) & 0x7ff;
    if exponent < 1023 {
        return Some(if integer == 0 {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    if exponent >= 1087 {
        return Some(Ordering::Less);
    }
    let significand = (bits & ((1_u64 << 52) - 1)) | (1_u64 << 52);
    if exponent >= 1075 {
        let shift = u32::try_from(exponent - 1075).ok()?;
        return Some(integer.cmp(&significand.checked_shl(shift)?));
    }
    let shift = u32::try_from(1075 - exponent).ok()?;
    let whole = significand.checked_shr(shift)?;
    let fraction = significand & (1_u64.checked_shl(shift)? - 1);
    let ordering = integer.cmp(&whole);
    Some(if ordering.is_eq() && fraction != 0 {
        Ordering::Less
    } else {
        ordering
    })
}

#[cfg(test)]
mod tests {
    use super::compare;
    use serde_json::Number;
    use std::cmp::Ordering;

    fn check(left: &Number, right: &Number, expected: Ordering) {
        assert_eq!(compare(left, right), Some(expected));
        assert_eq!(compare(right, left), Some(expected.reverse()));
    }

    fn float(value: f64) -> Result<Number, String> {
        Number::from_f64(value).ok_or_else(|| "Invalid floating test value".into())
    }

    #[test]
    fn adjacent_wide_integers_remain_distinct() {
        for start in [
            9_007_199_254_740_991_u64,
            i64::MAX.unsigned_abs(),
            u64::MAX - 1,
        ] {
            check(
                &Number::from(start),
                &Number::from(start + 1),
                Ordering::Less,
            );
        }
        check(
            &Number::from(i64::MIN),
            &Number::from(i64::MIN + 1),
            Ordering::Less,
        );
        check(
            &Number::from(i64::MIN),
            &Number::from(u64::MAX),
            Ordering::Less,
        );
        check(
            &Number::from(i64::MAX),
            &Number::from(i64::MAX.unsigned_abs()),
            Ordering::Equal,
        );
    }

    #[test]
    fn integer_float_comparisons_use_the_exact_binary_value() -> Result<(), String> {
        check(
            &Number::from(9_007_199_254_740_993_u64),
            &float(9_007_199_254_740_992.0)?,
            Ordering::Greater,
        );
        check(
            &Number::from(i64::MAX),
            &float(9_223_372_036_854_775_808.0)?,
            Ordering::Less,
        );
        check(
            &Number::from(i64::MIN),
            &float(-9_223_372_036_854_775_808.0)?,
            Ordering::Equal,
        );
        check(
            &Number::from(i64::MIN + 1),
            &float(-9_223_372_036_854_775_808.0)?,
            Ordering::Greater,
        );
        check(
            &Number::from(u64::MAX),
            &float(18_446_744_073_709_551_616.0)?,
            Ordering::Less,
        );
        check(
            &Number::from(18_446_744_073_709_549_568_u64),
            &float(18_446_744_073_709_551_616.0_f64.next_down())?,
            Ordering::Equal,
        );
        check(
            &Number::from(18_446_744_073_709_549_569_u64),
            &float(18_446_744_073_709_551_616.0_f64.next_down())?,
            Ordering::Greater,
        );
        Ok(())
    }

    #[test]
    fn fractions_subnormals_signs_and_signed_zero_keep_numeric_order() -> Result<(), String> {
        for value in [0.0, -0.0] {
            check(&Number::from(0), &float(value)?, Ordering::Equal);
        }
        for value in [f64::from_bits(1), 0.5, 1.0_f64.next_down()] {
            check(&Number::from(0), &float(value)?, Ordering::Less);
            check(&Number::from(1), &float(value)?, Ordering::Greater);
            check(&Number::from(0), &float(-value)?, Ordering::Greater);
            check(&Number::from(-1), &float(-value)?, Ordering::Less);
        }
        check(&Number::from(1), &float(1.5)?, Ordering::Less);
        check(&Number::from(-1), &float(-1.5)?, Ordering::Greater);
        check(&Number::from(u64::MAX), &float(f64::MAX)?, Ordering::Less);
        check(
            &Number::from(i64::MIN),
            &float(-f64::MAX)?,
            Ordering::Greater,
        );
        check(&float(-0.0)?, &float(0.0)?, Ordering::Equal);
        check(&float(0.25)?, &float(0.5)?, Ordering::Less);
        Ok(())
    }
}
