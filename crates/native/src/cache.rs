use lru::LruCache;
use std::rc::Rc;

pub struct Cache<T> {
    entries: LruCache<String, (Rc<T>, usize)>,
    bytes: usize,
    limit: usize,
}

impl<T> Cache<T> {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            entries: LruCache::unbounded(),
            bytes: 0,
            limit,
        }
    }

    pub(crate) fn get(&mut self, key: &str) -> Option<Rc<T>> {
        self.entries.get(key).map(|(value, _)| value.clone())
    }

    pub(crate) const fn bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn insert(&mut self, key: String, value: Rc<T>, bytes: usize) {
        let charge = bytes.saturating_add(key.capacity()).saturating_add(128);
        if charge > self.limit {
            return;
        }
        if let Some((_, removed)) = self.entries.pop(&key) {
            self.bytes -= removed;
        }
        while self.bytes + charge > self.limit {
            let Some((_, (_, removed))) = self.entries.pop_lru() else {
                break;
            };
            self.bytes -= removed;
        }
        drop(self.entries.put(key, (value, charge)));
        self.bytes += charge;
    }
}

#[cfg(test)]
mod tests {
    use super::Cache;
    use std::rc::Rc;

    #[test]
    fn eviction_preserves_active_handles_and_charges_replacement() {
        let mut cache = Cache::new(298);
        let first = Rc::new(vec![1; 16]);
        cache.insert(String::from("first"), first.clone(), 16);
        cache.insert(String::from("second"), Rc::new(vec![2; 16]), 16);
        assert!(cache.get("first").is_none());
        assert_eq!(first.as_slice(), &[1; 16]);
        cache.insert(String::from("second"), Rc::new(vec![3; 16]), 16);
        assert_eq!(cache.bytes(), 150);
        cache.insert(String::from("oversized"), Rc::new(vec![4; 301]), 301);
        assert_eq!(cache.bytes(), 150);
    }
}
