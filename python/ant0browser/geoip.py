"""geoip: resolve the egress IP's geo (timezone + lat/lon + language) so the browser matches the
proxy actually in use. Primary source is an offline all-in-one MaxMind DB (more accurate than a single online API; merges IP2Location +
GeoLite2 + DB-IP, timezone computed from coordinates), served from the Ant0 asset mirror. Flow:
discover the exit IP via Ant0's own IP echo (ip.ant0.link, zero request logging) *through the
proxy*, then look that IP up in the cached .mmdb. Falls back to ip.ant0.link/json (geo computed
server-side from the same DB, through the proxy) if the DB can't be fetched/opened.

Network endpoints, in order of preference (all overridable, read at call time):
  ANT0_BROWSER_IPECHO_URL   plain-text IP echo; default http://ip.ant0.link/ (then https://, then
                            the legacy third parties api.ipify.org / ip-api.com as a last resort)
  ANT0_BROWSER_GEOIP_URL    the .mmdb zip; default releases.ant0.link/ant0-assets/geoip/v1/...
  ANT0_BROWSER_GEOJSON_URL  JSON geo fallback; default http://ip.ant0.link/json

The .mmdb (GPL-3.0 data with IP2Location LITE / GeoLite2 / DB-IP attributions, see README) is
downloaded + cached on first use (~52 MB zip -> ~120 MB), NOT bundled. http(s) proxies only for the
lookup; SOCKS is skipped. Needs the `maxminddb` package (a dependency); if it's missing, falls back
to ip.ant0.link/json.
"""

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from urllib.parse import quote, urlsplit, urlunsplit
from ._errors import SdkRuntimeError

try:
    import maxminddb  # type: ignore
    _HAVE_MAXMINDDB = True
except ImportError:
    _HAVE_MAXMINDDB = False

DEFAULT_MMDB_URL = "https://releases.ant0.link/ant0-assets/geoip/v1/geoip-aio-all.mmdb.zip"
DEFAULT_IPECHO_URL = "http://ip.ant0.link/"
DEFAULT_GEOJSON_URL = "http://ip.ant0.link/json"
# Kept only as a last resort after both ip.ant0.link schemes fail (third parties, plain HTTP).
LEGACY_IPECHO_URLS = ("http://api.ipify.org", "http://ip-api.com/line/?fields=query")
MMDB_MAX_AGE_DAYS = 30


def geo_endpoints():
    """Endpoints with env overrides applied. Returns {"ipecho": [..], "mmdb": url, "geojson": url}."""
    ipecho = os.environ.get("ANT0_BROWSER_IPECHO_URL") or DEFAULT_IPECHO_URL
    urls = [ipecho]
    if ipecho == DEFAULT_IPECHO_URL:
        urls.append("https://" + ipecho[len("http://"):])
        urls.extend(LEGACY_IPECHO_URLS)
    return {
        "ipecho": urls,
        "mmdb": os.environ.get("ANT0_BROWSER_GEOIP_URL") or DEFAULT_MMDB_URL,
        "geojson": os.environ.get("ANT0_BROWSER_GEOJSON_URL") or DEFAULT_GEOJSON_URL,
    }
# dotted record paths for the geoip-all-in-one schema (GeoLite2-City shaped)
_PATHS = {"iso_code": "country.iso_code", "longitude": "location.longitude",
          "latitude": "location.latitude", "timezone": "location.time_zone"}


def _log(quiet, msg):
    if not quiet:
        sys.stderr.write(f"[ant0-browser] {msg}\n")
        sys.stderr.flush()


def _geo_cache_root():
    """Same location the Node SDK uses, so a downloaded DB is shared."""
    env = os.environ.get("ANT0_BROWSER_CACHE")
    if env:
        return os.path.join(env, "geoip")
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
        return os.path.join(base, "ant0-browser", "geoip")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~/Library/Caches"), "ant0-browser", "geoip")
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "ant0-browser", "geoip")


def _proxy_url(proxy):
    if not proxy or not proxy.get("server"):
        return None
    server = proxy["server"]
    if "://" not in server:
        server = "http://" + server
    user = proxy.get("username")
    if not user:
        return server
    parts = urlsplit(server)
    cred = quote(user, safe="")
    if proxy.get("password"):
        cred += ":" + quote(proxy["password"], safe="")
    netloc = f"{cred}@{parts.hostname}" + (f":{parts.port}" if parts.port else "")
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _find_in(data, dotted):
    for part in dotted.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
        if data is None:
            return None
    return data


def _opener(proxy_url):
    if proxy_url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )
    return urllib.request.build_opener()


def _looks_like_ip(s):
    if s.count(".") == 3 and all(p.isdigit() for p in s.split(".")):
        return True
    return ":" in s and all(c in "0123456789abcdefABCDEF:" for c in s)


def _exit_ip(proxy_url, quiet):
    op = _opener(proxy_url)
    for url in geo_endpoints()["ipecho"]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ant0-browser-sdk"})
            with op.open(req, timeout=8) as resp:
                ip = resp.read().decode("utf-8", "replace").split()[0].strip()
            if _looks_like_ip(ip):
                return ip
        except Exception:  # noqa: BLE001
            continue
    _log(quiet, "geoip: could not determine the exit IP")
    return None


def _ensure_mmdb(quiet):
    if not _HAVE_MAXMINDDB:
        return None
    d = _geo_cache_root()
    mmdb = os.path.join(d, "geoip-aio-all.mmdb")
    if os.path.exists(mmdb):
        age_days = (time.time() - os.path.getmtime(mmdb)) / 86400.0
        if age_days < MMDB_MAX_AGE_DAYS:
            return mmdb
    try:
        os.makedirs(d, exist_ok=True)
        _log(quiet, "geoip: downloading the geoip-all-in-one database (~52 MB, first run only)")
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            zpath = tmp.name
        try:
            with urllib.request.urlopen(  # noqa: S310
                urllib.request.Request(geo_endpoints()["mmdb"], headers={"User-Agent": "ant0-browser-sdk"}),
                timeout=120,
            ) as resp, open(zpath, "wb") as out:
                shutil.copyfileobj(resp, out)
            with zipfile.ZipFile(zpath) as z:
                member = next((n for n in z.namelist() if n.lower().endswith(".mmdb")), None)
                if not member:
                    raise SdkRuntimeError("sdk.geoip_archive_invalid", "no .mmdb in archive")
                with z.open(member) as src, open(mmdb, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        finally:
            try:
                os.remove(zpath)
            except OSError:
                pass
        _log(quiet, "geoip: database ready")
        return mmdb
    except Exception as e:  # noqa: BLE001
        _log(quiet, f"geoip: database fetch failed ({type(e).__name__}: {e}) — falling back to ip.ant0.link/json")
        return None


def _mmdb_lookup(ip, quiet):
    mmdb = _ensure_mmdb(quiet)
    if not mmdb:
        return None
    try:
        with maxminddb.open_database(mmdb) as reader:
            rec = reader.get(ip)
        if not rec:
            return None
        country = _find_in(rec, _PATHS["iso_code"])
        lat = _find_in(rec, _PATHS["latitude"])
        lon = _find_in(rec, _PATHS["longitude"])
        tz = _find_in(rec, _PATHS["timezone"])
        if not tz and lat is None:
            return None
        return {
            "ip": ip,
            "country": (str(country).upper() if country else None),
            "timezone": (str(tz) if tz else None),
            "accept_language": accept_language_for_country(country),
            "location": (f"{lat},{lon}" if lat is not None and lon is not None else None),
        }
    except Exception as e:  # noqa: BLE001
        _log(quiet, f"geoip: mmdb read failed ({type(e).__name__}: {e})")
        return None


def geo_from_echo_json(j):
    """Map a ``GET ip.ant0.link/json`` body ({ip, country, region, city, timezone, lat, lon, asn,
    org}; null when unknown) to the resolve_geo dict, or None when it carries no usable geo."""
    if not isinstance(j, dict) or not j.get("ip"):
        return None
    country = str(j["country"]).upper() if j.get("country") else None
    tz = j.get("timezone") or None
    lat, lon = j.get("lat"), j.get("lon")
    has_loc = isinstance(lat, (int, float)) and isinstance(lon, (int, float))
    if not tz and not has_loc and not country:
        return None
    return {
        "ip": j["ip"],
        "country": country,
        "timezone": tz,
        "accept_language": accept_language_for_country(country),
        "location": (f"{lat},{lon}" if has_loc else None),
    }


def _geo_json_fallback(proxy_url, quiet):
    # ip.ant0.link/json returns geo directly (through the proxy), no local DB needed.
    try:
        op = _opener(proxy_url)
        req = urllib.request.Request(geo_endpoints()["geojson"], headers={"User-Agent": "ant0-browser-sdk"})
        with op.open(req, timeout=8) as resp:
            return geo_from_echo_json(json.loads(resp.read().decode("utf-8", "replace")))
    except Exception:  # noqa: BLE001
        return None


def resolve_geo(proxy=None, quiet=False, timeout=8):
    """Resolve geo for the egress (through ``proxy`` if given, else direct). Never raises — returns
    None on failure. geoip-all-in-one offline DB first, ip.ant0.link/json fallback. Returns a dict
    {ip, country, timezone, accept_language, location} or None."""
    if proxy and proxy.get("server"):
        server = proxy["server"]
        scheme = server.split("://", 1)[0].lower() if "://" in server else "http"
        if scheme.startswith("socks"):
            _log(quiet, "geoip: SOCKS proxy can't be used for the geo lookup — "
                        "set timezone/accept_language explicitly. Skipping.")
            return None
    proxy_url = _proxy_url(proxy)
    ip = _exit_ip(proxy_url, quiet)
    geo = _mmdb_lookup(ip, quiet) if ip else None
    if not geo:
        geo = _geo_json_fallback(proxy_url, quiet)
    if geo:
        _log(quiet, f"geoip: {geo['ip']} -> {geo['country']} "
                    f"tz={geo['timezone']} lang={geo['accept_language']}")
    return geo


# country (ISO-3166 alpha-2) -> Accept-Language. Plain comma list (NO ;q= weights). The geoip DB
# has no language data, so this maps the resolved country. Falls back to en-US,en.
COUNTRY_LANG = {
    "US": "en-US,en", "GB": "en-GB,en", "CA": "en-CA,en,fr-CA", "AU": "en-AU,en", "NZ": "en-NZ,en",
    "IE": "en-IE,en", "IN": "en-IN,en,hi", "ZA": "en-ZA,en", "SG": "en-SG,en",
    "DE": "de-DE,de,en", "AT": "de-AT,de,en", "CH": "de-CH,de,fr,en",
    "FR": "fr-FR,fr,en", "BE": "nl-BE,nl,fr,en", "NL": "nl-NL,nl,en",
    "ES": "es-ES,es,en", "MX": "es-MX,es,en", "AR": "es-AR,es,en", "CL": "es-CL,es,en",
    "CO": "es-CO,es,en", "PT": "pt-PT,pt,en", "BR": "pt-BR,pt,en",
    "IT": "it-IT,it,en", "PL": "pl-PL,pl,en", "RU": "ru-RU,ru,en", "UA": "uk-UA,uk,ru,en",
    "SE": "sv-SE,sv,en", "NO": "nb-NO,no,en", "DK": "da-DK,da,en", "FI": "fi-FI,fi,en",
    "CZ": "cs-CZ,cs,en", "RO": "ro-RO,ro,en", "HU": "hu-HU,hu,en", "GR": "el-GR,el,en",
    "TR": "tr-TR,tr,en", "IL": "he-IL,he,en", "SA": "ar-SA,ar,en", "AE": "ar-AE,ar,en",
    "EG": "ar-EG,ar,en", "JP": "ja-JP,ja,en", "KR": "ko-KR,ko,en",
    "CN": "zh-CN,zh,en", "HK": "zh-HK,zh,en", "TW": "zh-TW,zh,en",
    "TH": "th-TH,th,en", "VN": "vi-VN,vi,en", "ID": "id-ID,id,en",
    "MY": "ms-MY,ms,en", "PH": "en-PH,en,fil",
}


def accept_language_for_country(cc):
    if not cc:
        return "en-US,en"
    return COUNTRY_LANG.get(str(cc).upper(), "en-US,en")
