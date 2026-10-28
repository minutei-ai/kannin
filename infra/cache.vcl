vcl 4.1;

backend default {
    .host = "127.0.0.1";
    .port = "6082";
    .connect_timeout = 1s;
    .first_byte_timeout = 2s;
    .between_bytes_timeout = 2s;
}

sub vcl_recv {
    if (req.method != "GET" || req.url !~ "^/objects/") {
        return (synth(404));
    }
    unset req.http.Authorization;
    unset req.http.Cookie;
    unset req.http.Accept-Encoding;
    return (hash);
}

sub vcl_backend_response {
    set beresp.grace = 0s;
    set beresp.keep = 0s;
    if (beresp.status != 200 || beresp.ttl <= 0s) {
        set beresp.uncacheable = true;
        set beresp.ttl = 0s;
    }
}
