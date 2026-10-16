FROM rust:1.96.0-slim-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates
RUN cargo build --locked --release --package kannin-native

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/kannin-native /kannin-native
COPY --from=build /build/LICENSE /LICENSE
EXPOSE 8080
ENTRYPOINT ["/kannin-native"]
