from ant0browser.geoip import (_exit_ip, accept_language_for_country, geo_endpoints,
                               geo_from_echo_json, resolve_geo)


def test_accept_language_for_country():
    assert accept_language_for_country("US") == "en-US,en"
    assert accept_language_for_country("de") == "de-DE,de,en"  # case-insensitive
    assert accept_language_for_country("BR") == "pt-BR,pt,en"
    assert accept_language_for_country("JP") == "ja-JP,ja,en"


def test_accept_language_fallback():
    assert accept_language_for_country("ZZ") == "en-US,en"
    assert accept_language_for_country("") == "en-US,en"
    assert accept_language_for_country(None) == "en-US,en"


def test_accept_language_has_no_q_weights():
    # A ';q=' in --accept-lang trips a Chromium DCHECK; the map must never contain one.
    for cc in ("US", "DE", "FR", "CA", "BR", "JP", "ZZ"):
        assert ";" not in accept_language_for_country(cc)


def test_resolve_geo_socks_returns_none():
    # SOCKS can't be used for the geo lookup and we must not fall back to the local IP
    # under a proxy (wrong region) — returns None without any network call.
    assert resolve_geo({"server": "socks5://127.0.0.1:9050"}, quiet=True) is None


def test_geo_endpoints_default_to_ant0_then_third_parties(monkeypatch):
    for k in ("ANT0_BROWSER_IPECHO_URL", "ANT0_BROWSER_GEOIP_URL", "ANT0_BROWSER_GEOJSON_URL"):
        monkeypatch.delenv(k, raising=False)
    e = geo_endpoints()
    # plain http first: the proxy probe must stay an absolute-form http request; https second;
    # the legacy third parties only as a last resort.
    assert e["ipecho"][:2] == ["http://ip.ant0.link/", "https://ip.ant0.link/"]
    assert e["ipecho"][2:] == ["http://api.ipify.org", "http://ip-api.com/line/?fields=query"]
    assert e["mmdb"] == "https://releases.ant0.link/ant0-assets/geoip/v1/geoip-aio-all.mmdb.zip"
    assert e["geojson"] == "http://ip.ant0.link/json"


def test_geo_endpoints_env_overrides_drop_third_parties(monkeypatch):
    monkeypatch.setenv("ANT0_BROWSER_IPECHO_URL", "http://127.0.0.1:9/")
    monkeypatch.setenv("ANT0_BROWSER_GEOIP_URL", "https://mirror.example/geo.zip")
    monkeypatch.setenv("ANT0_BROWSER_GEOJSON_URL", "http://127.0.0.1:9/json")
    e = geo_endpoints()
    assert e["ipecho"] == ["http://127.0.0.1:9/"]
    assert e["mmdb"] == "https://mirror.example/geo.zip"
    assert e["geojson"] == "http://127.0.0.1:9/json"


def test_exit_ip_parses_local_echo(monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Echo(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = b"203.0.113.7\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence
            pass

    srv = HTTPServer(("127.0.0.1", 0), Echo)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        monkeypatch.setenv("ANT0_BROWSER_IPECHO_URL", f"http://127.0.0.1:{srv.server_port}/")
        assert _exit_ip(None, quiet=True) == "203.0.113.7"
    finally:
        srv.shutdown()


def test_geo_from_echo_json_maps_fields():
    g = geo_from_echo_json({"ip": "203.0.113.7", "country": "us", "region": None, "city": None,
                            "timezone": "America/Chicago", "lat": 39.09973, "lon": -94.57857,
                            "asn": None, "org": None})
    assert g == {"ip": "203.0.113.7", "country": "US", "timezone": "America/Chicago",
                 "accept_language": "en-US,en", "location": "39.09973,-94.57857"}


def test_geo_from_echo_json_without_geo_is_none():
    assert geo_from_echo_json({"ip": "203.0.113.7", "country": None, "timezone": None, "lat": None, "lon": None}) is None
    assert geo_from_echo_json(None) is None
    assert geo_from_echo_json({}) is None
