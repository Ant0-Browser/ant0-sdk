"""Schema 4 personas, canvas mode and the per-profile canvas noise key (parity with the Node SDK)."""

import base64
import copy
import gzip
import json
import os
import stat
import sys
from pathlib import Path

import pytest

from ant0browser import (
    IdentityPersistenceError, PersonaV4SchemaError, canvas_mode, canvas_noise_key_for,
    create_or_load_generated_identity, create_or_load_issued_identity, derive_canvas_noise_key,
    load_persisted_identity, new_canvas_noise_key, prepare_identity_options, resolve_identity,
    validate_persisted_identity, validate_persona_profile_v4,
)
from ant0browser._fingerprint import FINGERPRINT_KEYS, fingerprint_args
from ant0browser._profile_file import (
    PROFILE_FILE_NAME, parse_sdk_info_schemas, stage_persona_profile,
)
from ant0browser._warnings import coherence_warnings

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"
KEY = "2092fc8be8f13c86"
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")


def v2():
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def v4(brand="edge"):
    """A small synthetic schema 4 persona: the structural fields the validator reads, nothing else."""
    return {
        "schema_version": 4, "schema_revision": 1, "requires": ["display", "input"],
        "provenance": {"source": "synthetic",
                       "model": {"version": "population-model-v2.2", "sha256": "0" * 64}},
        "identity": {
            "os": {"family": "windows", "release": "windows-11", "platform_version": "19.0.0",
                   "architecture": "x86_64"},
            "engine": {"family": "blink", "major": 158},
            "brand": {"id": brand, "version": "158.0.4370.16"},
            "form_factor": "desktop", "device_model": "",
        },
        "surfaces": {"display": {"width": 1920}, "x-unknown": {"ignored": True}},
    }


def fake_engine(tmp_path, output, name="chrome"):
    if sys.platform == "win32":
        pytest.skip("the fake engines are /bin/sh scripts")
    path = tmp_path / name
    # The capability marker makes the script pass the SDK's "is an Ant0 build" check.
    path.write_text(f"#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n{output}\nJSON\n")
    path.chmod(0o755)
    return str(path)


CAPABILITIES = ["navigator","navigator.ua_ch","display","input","gpu.webgl","gpu.webgpu","fonts","speech","audio","media.decoding","media.devices","network"]


def info(schemas, protocol=2, **extra):
    persona = {"schemas": schemas, "revision": 1, "engine_family": "blink", "engine_major": 158,
               "capabilities": CAPABILITIES, **extra}
    return json.dumps({"sdk_protocol": protocol, "persona": persona})


def decode_file(path):
    return json.loads(gzip.decompress(base64.b64decode(Path(path).read_text())).decode("utf-8"))


class TestValidator:
    def test_accepts_valid_and_ignores_unknown_keys(self):
        validate_persona_profile_v4(v4())

    @pytest.mark.parametrize("mutate", [
        lambda p: p.update(schema_version=2),
        lambda p: p.update(requires=["a", "a"]),
        lambda p: p["provenance"].update(source="captured"),
        lambda p: p["provenance"].update(attempt=1),
        lambda p: p["identity"]["engine"].update(family="gecko"),
        lambda p: p["identity"].pop("brand"),
        lambda p: p.update(surfaces=[]),
    ])
    def test_rejects_invalid(self, mutate):
        p = v4()
        mutate(p)
        with pytest.raises(PersonaV4SchemaError):
            validate_persona_profile_v4(p)


class TestOptionCombinations:
    @pytest.mark.parametrize("canvas", ["real", "noise"])
    def test_canvas_with_the_direct_fingerprint_seed_is_refused(self, canvas):
        with pytest.raises(Exception) as err:
            fingerprint_args({"fingerprint": "seed", "canvas": canvas, "canvas_noise_key": KEY})
        assert err.value.code == "sdk.canvas_invalid" and "fingerprint seed" in str(err.value)
        fingerprint_args({"fingerprint": "seed"})
        fingerprint_args({"canvas": "real"})

    def test_a_schema4_persona_given_as_text_says_so_instead_of_file_missing(self, tmp_path):
        path = tmp_path / "persona.json"
        path.write_text(json.dumps(v4()))
        for text in (str(path), json.dumps(v4())):
            with pytest.raises(Exception) as err:
                fingerprint_args({"fingerprint_profile": text}, identity_api=True)
            assert err.value.code == "sdk.persona_profile_invalid" and "identity" in str(err.value)


class TestNoiseKey:
    def with_key(self, key):
        p = v4()
        if key != "absent":
            p["provenance"]["noise_key"] = key
        return p

    def test_is_optional_and_a_valid_key_passes(self):
        validate_persona_profile_v4(self.with_key("absent"))
        validate_persona_profile_v4(self.with_key("0123456789abcdef"))

    @pytest.mark.parametrize("key", ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0x23456789abcdef",
                                     "0123456789abcdeg", "0123456789abcdef\n", "", None, 7, {}])
    def test_must_be_16_lowercase_hex_when_present(self, key):
        with pytest.raises(PersonaV4SchemaError, match="noise_key"):
            validate_persona_profile_v4(self.with_key(key))

    def test_a_missing_key_is_only_a_debug_line(self, tmp_path, capsys, monkeypatch):
        from ant0browser import _profile_file as pf
        probe = lambda _e: (True, json.dumps({"sdk_protocol": 2, "persona": {"schemas": [2, 4], "capabilities": ["display", "input"]}}))
        monkeypatch.delenv("ANT0_BROWSER_DEBUG", raising=False)
        pf.reset_engine_probe_cache()
        pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", str(tmp_path / "a"), probe=probe,
                                 run=lambda *_: "", platform="linux")
        assert "noise_key" not in capsys.readouterr().err
        monkeypatch.setenv("ANT0_BROWSER_DEBUG", "1")
        pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", str(tmp_path / "b"), probe=probe,
                                 run=lambda *_: "", platform="linux")
        assert "debug:" in capsys.readouterr().err


class TestWrapper:
    def wrapper3(self, **extra):
        return {"schema_version": 3, "algorithm": "ant0/persona-generate/v2.2",
                "algorithm_ref": "population-model-v2.2", "created_at": "2026-11-14T10:00:00Z",
                "profile": v4(), "canvas_noise_key": KEY, **extra}

    def test_accepts_schema4_with_a_key(self):
        assert validate_persisted_identity(self.wrapper3())["schema_version"] == 3

    def test_requires_the_key_in_a_v3_wrapper(self):
        keyless = self.wrapper3()
        del keyless["canvas_noise_key"]
        with pytest.raises(IdentityPersistenceError, match="canvas_noise_key is required"):
            validate_persisted_identity(keyless)
        with pytest.raises(IdentityPersistenceError):
            validate_persisted_identity({**keyless, "canvas_noise_key": None})

    def test_rejects_bad_key_and_mismatched_profile(self):
        for bad in ("0x" + KEY[2:], KEY.upper()):
            with pytest.raises(IdentityPersistenceError):
                validate_persisted_identity(self.wrapper3(canvas_noise_key=bad))
        with pytest.raises(IdentityPersistenceError):
            validate_persisted_identity({**self.wrapper3(), "profile": v2()})
        with pytest.raises(IdentityPersistenceError):
            validate_persisted_identity({**self.wrapper3(), "schema_version": 2,
                                         "algorithm": "ant0/persona-generate/v1"})

    def test_v2_wrapper_unchanged(self):
        w = {"schema_version": 2, "algorithm": "ant0/persona-generate/v1", "algorithm_ref": "m1",
             "created_at": "2026-11-14T10:00:00Z", "profile": v2()}
        assert validate_persisted_identity(w)["schema_version"] == 2
        assert validate_persisted_identity({**w, "canvas_noise_key": KEY})["schema_version"] == 2

    def test_issued_v4_is_stored_once_with_a_fresh_key(self, tmp_path):
        first = create_or_load_issued_identity("acct", v4(), "ant0/persona-generate/v2.2",
                                               "population-model-v2.2", tmp_path)
        assert first["schema_version"] == 3
        assert len(first["canvas_noise_key"]) == 16
        second = create_or_load_issued_identity("acct", v4("chrome"), "ant0/persona-generate/v2.2",
                                                "population-model-v2.2", tmp_path)
        assert second == first
        assert load_persisted_identity("acct", tmp_path) == first

    def test_issued_v2_uses_a_v2_wrapper_without_a_key(self, tmp_path):
        w = create_or_load_issued_identity("acct2", v2(), "ant0/persona-generate/v1",
                                           "population-model-v1", tmp_path)
        assert w["schema_version"] == 2
        assert "canvas_noise_key" not in w

    def test_new_generated_v2_identity_stores_no_key_and_is_not_rewritten(self, tmp_path):
        model = json.loads((FIXTURES / "population-generate-v1.json").read_text())["model"]
        created = create_or_load_generated_identity("k", model, tmp_path)
        assert "canvas_noise_key" not in created
        files = [f for f in tmp_path.iterdir() if f.suffix == ".json"]
        before = files[0].read_text()
        assert create_or_load_generated_identity("k", model, tmp_path) == created
        assert files[0].read_text() == before


#: The exact field sets origin/main readers require for each wrapper version.
OLD_V1_FIELDS = {"created_at", "profile", "schema_version", "template_id", "template_selection_algorithm"}
OLD_V2_FIELDS = {"algorithm", "algorithm_ref", "created_at", "profile", "schema_version"}


def on_disk(directory):
    files = [f for f in Path(directory).iterdir() if f.name != "device.key"]
    assert len(files) == 1
    return json.loads(files[0].read_text(encoding="utf-8"))


class TestOlderReaders:
    def test_generated_v2_file_has_exactly_the_origin_main_field_set(self, tmp_path):
        model = json.loads((FIXTURES / "population-generate-v1.json").read_text())["model"]
        create_or_load_generated_identity("k", model, tmp_path)
        w = on_disk(tmp_path)
        assert w["schema_version"] == 2
        assert set(w) == OLD_V2_FIELDS

    def test_issued_v2_file_has_exactly_the_origin_main_field_set(self, tmp_path):
        create_or_load_issued_identity("k", v2(), "ant0/persona-generate/v1", "m", tmp_path)
        w = on_disk(tmp_path)
        assert w["schema_version"] == 2
        assert set(w) == OLD_V2_FIELDS

    def test_v3_file_carries_the_random_key(self, tmp_path):
        create_or_load_issued_identity("k", v4(), "ant0/persona-generate/v2.2", "population-model-v2.2", tmp_path)
        w = on_disk(tmp_path)
        assert w["schema_version"] == 3
        assert set(w) == OLD_V2_FIELDS | {"canvas_noise_key"}
        assert len(w["canvas_noise_key"]) == 16 and w["canvas_noise_key"] == w["canvas_noise_key"].lower()

    def test_different_identity_keys_derive_different_canvas_keys(self):
        assert derive_canvas_noise_key("a-1") != derive_canvas_noise_key("a-2")

    @pytest.mark.parametrize("bad", ["0x" + KEY[2:], KEY.upper(), KEY[1:], KEY + "0", "", 5, None,
                                     "zzzzzzzzzzzzzzzz"])
    def test_readers_reject_a_malformed_optional_key_in_v1_and_v2(self, bad):
        v1 = {"schema_version": 1, "template_selection_algorithm": "ant0/persona-template-selection/v1",
              "template_id": "t1", "created_at": "2026-11-14T10:00:00Z", "profile": v2()}
        v2w = {"schema_version": 2, "algorithm": "ant0/persona-generate/v1", "algorithm_ref": "m1",
               "created_at": "2026-11-14T10:00:00Z", "profile": v2()}
        for w in (v1, v2w):
            validate_persisted_identity({**w, "canvas_noise_key": KEY})  # a valid one is accepted
            with pytest.raises(IdentityPersistenceError):
                validate_persisted_identity({**w, "canvas_noise_key": bad})


class TestV3Algorithm:
    def w3(self, **extra):
        return {"schema_version": 3, "algorithm": "ant0/persona-generate/v2.2",
                "algorithm_ref": "population-model-v2.2", "created_at": "2026-11-14T10:00:00Z",
                "profile": v4(), "canvas_noise_key": KEY, **extra}

    def test_known_generator_names_pass(self):
        validate_persisted_identity(self.w3())
        validate_persisted_identity(self.w3(algorithm="ant0/persona-generate/v3.0"))

    @pytest.mark.parametrize("algorithm", ["other/persona-generate/v2.2", "ant0/persona-generate/",
                                           "ant0/persona-generate/../x", "", 2, None])
    def test_anything_else_is_rejected(self, algorithm):
        with pytest.raises(IdentityPersistenceError):
            validate_persisted_identity(self.w3(algorithm=algorithm))

    def test_unsafe_algorithm_ref_is_rejected(self):
        with pytest.raises(IdentityPersistenceError):
            validate_persisted_identity(self.w3(algorithm_ref="../x"))


class TestKey:
    def test_derived_key_matches_pinned_vectors(self):
        assert derive_canvas_noise_key("account-42") == KEY
        assert derive_canvas_noise_key("") == "6823a00150088ea3"
        assert derive_canvas_noise_key("профиль-1") == "ad17a5bc990e445e"

    def test_new_keys_are_random_16_hex(self):
        keys = {new_canvas_noise_key() for _ in range(50)}
        assert len(keys) == 50
        assert all(len(k) == 16 and k == k.lower() and int(k, 16) >= 0 for k in keys)

    def test_stored_key_wins_and_legacy_derives(self):
        assert canvas_noise_key_for({"canvas_noise_key": "00112233445566ff"}, "account-42") == "00112233445566ff"
        assert canvas_noise_key_for({}, "account-42") == KEY


class TestSwitches:
    def noise(self, **o):
        return [a for a in fingerprint_args(o) if a.startswith("--fingerprint-noise-key")]

    def test_real_sends_no_key(self):
        assert self.noise(canvas="real", canvas_noise_key=KEY) == []
        assert self.noise() == []

    def test_noise_sends_exactly_one(self):
        assert self.noise(canvas="noise", canvas_noise_key=KEY) == [f"--fingerprint-noise-key={KEY}"]

    def test_missing_or_malformed_key(self):
        with pytest.raises(ValueError, match="canvas_noise_key"):
            fingerprint_args({"canvas": "noise"})
        for bad in ("abc", "0x" + KEY[2:], KEY.upper(), KEY + "0"):
            with pytest.raises(ValueError, match="16 lowercase hex"):
                fingerprint_args({"canvas": "noise", "canvas_noise_key": bad})
        with pytest.raises(ValueError):
            canvas_mode({"canvas": "loud"})

    def test_legacy_mapping(self):
        assert canvas_mode({}) == "real"
        assert canvas_mode({"canvas_noise": True}) == "real"      # legacy flags never enable noise
        assert canvas_mode({"fingerprint_noise": True}) == "real"
        assert canvas_mode({"canvas_noise": True, "fingerprint_noise": True}) == "real"
        assert canvas_mode({"canvas_noise": False, "fingerprint_noise": False}) == "real"
        assert canvas_mode({"canvas": "real", "canvas_noise": True}) == "real"
        assert canvas_mode({"canvas": "noise", "canvas_noise": False}) == "noise"
        assert self.noise(canvas_noise=True, canvas_noise_key=KEY) == []
        assert self.noise(canvas="noise", canvas_noise_key=KEY) == [f"--fingerprint-noise-key={KEY}"]

    def test_seed_path_disable_switches_unchanged(self):
        args = fingerprint_args({"fingerprint": "s", "canvas_noise": False, "fingerprint_noise": False})
        assert "--disable-canvas-noise" in args and "--disable-fingerprint-noise" in args
        assert fingerprint_args({"canvas_noise": True}) == fingerprint_args({})

    def test_new_keys_are_fingerprint_keys(self):
        assert {"canvas", "canvas_noise_key"} <= set(FINGERPRINT_KEYS)


class TestIdentityPath:
    def test_noise_key_from_option_then_identity_then_error(self, tmp_path):
        create_or_load_issued_identity("acct", v4(), "ant0/persona-generate/v2.2",
                                       "population-model-v2.2", tmp_path)
        stored = load_persisted_identity("acct", tmp_path)["canvas_noise_key"]
        ident = {"mode": "synthetic", "key": "acct", "identity_directory": str(tmp_path)}

        def prep(**ov):
            return prepare_identity_options({"identity": ident, "overrides": ov}, FINGERPRINT_KEYS)[1]

        assert prep(canvas="noise")["canvas_noise_key"] == stored
        assert prep(canvas="noise", canvas_noise_key=KEY)["canvas_noise_key"] == KEY
        assert "canvas_noise_key" not in prepare_identity_options({"identity": ident}, FINGERPRINT_KEYS)[1]
        for identity in ({"mode": "native"}, {"mode": "captured", "source": v2()}):
            with pytest.raises(ValueError) as err:
                prepare_identity_options({"identity": identity, "overrides": {"canvas": "noise"}},
                                         FINGERPRINT_KEYS)
            assert err.value.code == "sdk.canvas_key_missing"

    # What every legacy shape did on main (the SDK pinned at 0277779): False sent the matching --disable-*
    # switch, True and absent sent nothing, for every identity mode. None of it enables noise.
    @pytest.mark.parametrize("mode", ["native", "captured v2", "captured v4", "synthetic"])
    @pytest.mark.parametrize("canvas_noise", [True, False, None])
    @pytest.mark.parametrize("fingerprint_noise", [True, False, None])
    def test_legacy_shapes_stay_real_as_on_main(self, mode, canvas_noise, fingerprint_noise, tmp_path, capfd):
        identity = {"native": {"mode": "native"},
                    "captured v2": {"mode": "captured", "source": v2()},
                    "captured v4": {"mode": "captured", "source": v4()}}.get(mode)
        if mode == "synthetic":
            create_or_load_issued_identity("acct", v4(), "ant0/persona-generate/v2.2",
                                           "population-model-v2.2", tmp_path)
            identity = {"mode": "synthetic", "key": "acct", "identity_directory": str(tmp_path)}
        overrides = {}
        if canvas_noise is not None:
            overrides["canvas_noise"] = canvas_noise
        if fingerprint_noise is not None:
            overrides["fingerprint_noise"] = fingerprint_noise
        _, out = prepare_identity_options({"identity": identity, "overrides": overrides}, FINGERPRINT_KEYS)
        assert canvas_mode(out) == "real" and "canvas_noise_key" not in out
        extra = {"fingerprint_profile_file": "/x"} if (out.get("fingerprint_profile") or {}).get("schema_version") == 4 else {}
        args = fingerprint_args({**out, **extra}, identity_api=True)
        assert not [a for a in args if a.startswith("--fingerprint-noise-key")]
        assert ("--disable-canvas-noise" in args) == (canvas_noise is False)
        assert ("--disable-fingerprint-noise" in args) == (fingerprint_noise is False)
        err = capfd.readouterr().err
        assert err.count("canvas-noise-no-key") == (1 if (canvas_noise is True or fingerprint_noise is True) else 0)

    def test_the_legacy_warning_is_quiet_when_asked_and_not_given_for_explicit_noise(self, capfd):
        prepare_identity_options({"identity": {"mode": "native"}, "overrides": {"canvas_noise": True}, "quiet": True},
                                 FINGERPRINT_KEYS)
        prepare_identity_options({"identity": {"mode": "native"},
                                  "overrides": {"canvas": "noise", "canvas_noise": True, "canvas_noise_key": KEY}},
                                 FINGERPRINT_KEYS)
        assert "canvas-noise-no-key" not in capfd.readouterr().err


    def test_v2_wrapper_has_no_key_and_derives_one_from_identity_key(self, tmp_path):
        create_or_load_issued_identity("account-42", v2(), "ant0/persona-generate/v1", "m", tmp_path)
        ident = {"mode": "synthetic", "key": "account-42", "identity_directory": str(tmp_path)}
        _, out = prepare_identity_options({"identity": ident, "overrides": {"canvas": "noise"}},
                                          FINGERPRINT_KEYS)
        assert out["canvas_noise_key"] == KEY

    def test_schema4_persona_derives_no_identity_switch(self):
        mode, opts = resolve_identity({"mode": "captured", "source": v4()})
        assert list(opts) == ["fingerprint_profile"]
        _, prepared = prepare_identity_options({"identity": {"mode": "captured", "source": v4()}}, FINGERPRINT_KEYS)
        for k in ("platform", "brand", "brand_version", "platform_version"):
            assert k not in prepared, k
        args = fingerprint_args({**prepared, "fingerprint_profile_file": "/x"}, identity_api=True)
        assert [a for a in args if a.startswith(("--fingerprint-brand", "--fingerprint-platform", "--fingerprint-tls"))] == []
        assert "--fingerprint-profile-file=/x" in args

    def test_platform_and_brand_overrides_pass_only_the_users_values_and_warn(self, capsys, monkeypatch):
        from ant0browser._warnings import PERSONA_IDENTITY_OVERRIDE_MESSAGE
        monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)

        def only(overrides, quiet=False):
            _, prepared = prepare_identity_options(
                {"identity": {"mode": "captured", "source": v4()}, "overrides": overrides, "quiet": quiet},
                FINGERPRINT_KEYS)
            args = fingerprint_args({**prepared, "fingerprint_profile_file": "/x"}, identity_api=True)
            return [a for a in args if a.startswith(("--fingerprint-brand", "--fingerprint-platform", "--fingerprint-tls"))]

        assert only({"platform": "windows"}) == ["--fingerprint-platform=windows"]
        assert only({"brand": "chrome"}) == ["--fingerprint-brand=chrome"]
        assert only({"brand": "chrome", "brand_version": "150.0.1.2"}) == [
            "--fingerprint-brand=chrome", "--fingerprint-brand-version=150.0.1.2", "--fingerprint-tls-profile=chrome-150"]
        err = capsys.readouterr().err
        assert err.count("[persona-identity-override]") == 3
        assert f"ant0browser: warning: [persona-identity-override] {PERSONA_IDENTITY_OVERRIDE_MESSAGE}\n" in err
        only({"brand": "chrome"}, quiet=True)
        prepare_identity_options({"identity": {"mode": "captured", "source": v2()}, "overrides": {"brand": "chrome"}},
                                 FINGERPRINT_KEYS)
        assert "persona-identity-override" not in capsys.readouterr().err

    def test_an_android_schema4_persona_still_gets_the_phone_window_without_a_platform_switch(self):
        p = v4()
        p["identity"]["os"]["family"] = "android"
        p["identity"]["form_factor"] = "phone"
        p["identity"]["brand"]["id"] = "chrome"
        args = fingerprint_args({"fingerprint_profile": p, "fingerprint_profile_file": "/x"}, identity_api=True)
        assert "--window-size=412,915" in args
        assert not any(a.startswith("--fingerprint-platform") for a in args)

    def test_v2_identity_options_unchanged(self):
        _, opts = resolve_identity({"mode": "captured", "source": v2()})
        assert opts["brand"] == "chrome"
        assert "brand_version" not in opts and "platform_version" not in opts


class TestPersonaFile:
    @posix_only
    def test_file_is_private_roundtrips_and_uses_the_file_switch(self, tmp_path):
        udd = tmp_path / "udd"
        engine = fake_engine(tmp_path, info([2, 4]))
        fp = stage_persona_profile({"fingerprint_profile": v4()}, engine, udd)
        path = fp["fingerprint_profile_file"]
        assert path == str(udd / PROFILE_FILE_NAME)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert decode_file(path) == v4()
        args = fingerprint_args(fp, identity_api=True)
        assert f"--fingerprint-profile-file={path}" in args
        assert not any(a.startswith("--fingerprint-profile=") for a in args)
        assert [p.name for p in udd.iterdir()] == [PROFILE_FILE_NAME]

    @posix_only
    def test_replaces_existing_file_atomically(self, tmp_path):
        udd = tmp_path / "udd"
        engine = fake_engine(tmp_path, info([2, 4]))
        stage_persona_profile({"fingerprint_profile": v4("chrome")}, engine, udd)
        fp = stage_persona_profile({"fingerprint_profile": v4("edge")}, engine, udd)
        assert decode_file(fp["fingerprint_profile_file"])["identity"]["brand"]["id"] == "edge"
        assert stat.S_IMODE(os.stat(fp["fingerprint_profile_file"]).st_mode) == 0o600

    @posix_only
    def test_engine_without_schema4_is_refused_and_nothing_is_written(self, tmp_path):
        udd = tmp_path / "udd"
        engines = [fake_engine(tmp_path, info([2]), "a"), fake_engine(tmp_path, info([2, 4], 1), "b"),
                   fake_engine(tmp_path, "not json", "c"), str(tmp_path / "missing")]
        for engine in engines:
            with pytest.raises(Exception) as err:
                stage_persona_profile({"fingerprint_profile": v4()}, engine, udd)
            assert err.value.code == "sdk.persona_requires_engine"
        assert not udd.exists()

    def test_schema4_never_goes_inline(self):
        with pytest.raises(ValueError, match="private file"):
            fingerprint_args({"fingerprint_profile": v4()}, identity_api=True)

    def test_v2_stays_inline_and_is_not_staged(self, tmp_path):
        fp = {"fingerprint_profile": v2()}
        assert stage_persona_profile(fp, "/nonexistent/chrome", tmp_path) is fp
        args = fingerprint_args(fp, identity_api=True)
        assert any(a.startswith("--fingerprint-profile=") for a in args)
        assert not any(a.startswith("--fingerprint-profile-file") for a in args)

    def test_reads_the_advertisement(self):
        assert parse_sdk_info_schemas(info([2, 4])) == [2, 4]
        assert parse_sdk_info_schemas(info([2, 4], 1)) == [2]
        assert parse_sdk_info_schemas("") == [2]


class TestWarningsText:
    def test_edge_schema4_persona_is_not_a_brand_mismatch(self):
        w = coherence_warnings({"brand": "edge", "fingerprint_profile": v4(), "headless": False},
                               "win32", "158")
        assert "brand-mismatch" not in {x["code"] for x in w}


class TestPrepareEndToEnd:
    @posix_only
    def test_prepare_stages_the_file_and_swaps_the_placeholder(self, tmp_path):
        import ant0browser as pkg
        engine = fake_engine(tmp_path, info([2, 4]))
        udd = tmp_path / "udd"
        kwargs = {"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                  "launch_ticket": False, "quiet": True, "_ant0_user_data_dir": str(udd)}
        exe, args, pw_kwargs, *_ = pkg._prepare(kwargs)
        pkg._take_internal(pw_kwargs)
        want = f"--fingerprint-profile-file={udd / PROFILE_FILE_NAME}"
        assert args.count(want) == 1
        assert not any("ant0-persona-file" in a or a.startswith("--fingerprint-profile=") for a in args)
        assert decode_file(udd / PROFILE_FILE_NAME) == v4()
        assert not any(a.startswith(("--fingerprint-brand", "--fingerprint-platform")) for a in args)  # the profile file is the only source

    @posix_only
    def test_prepare_refuses_an_engine_without_schema4(self, tmp_path):
        import ant0browser as pkg
        engine = fake_engine(tmp_path, info([2]))
        kwargs = {"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                  "launch_ticket": False, "quiet": True, "_ant0_user_data_dir": str(tmp_path / "udd")}
        with pytest.raises(Exception) as err:
            pkg._prepare(kwargs)
        assert err.value.code == "sdk.persona_requires_engine"


class TestSchema4Display:
    DISPLAY = {"width": 2560, "height": 1440, "avail_width": 1920, "avail_height": 1040,
               "avail_left": 0, "avail_top": 0, "device_pixel_ratio": 1.25}

    def with_display(self, d):
        p = v4()
        p["surfaces"]["display"] = d
        return p

    def test_scale_and_avail_come_from_surfaces_display(self):
        from ant0browser._fingerprint import persona_avail, persona_dpr
        fp = {"fingerprint_profile": self.with_display(self.DISPLAY)}
        assert persona_dpr(fp) == 1.25
        assert persona_avail(fp) == (1920, 1040)

    def test_same_flags_as_v2_with_the_same_numbers(self):
        from ant0browser._fingerprint import persona_avail
        p2 = v2()
        p2["display"].update(device_pixel_ratio=1.25, available_width=1920, available_height=1040)
        flag = lambda a: [x for x in a if x.startswith("--force-device-scale-factor")]
        a = flag(fingerprint_args({"fingerprint_profile": p2}, identity_api=True))
        b = flag(fingerprint_args({"fingerprint_profile": self.with_display(self.DISPLAY),
                                   "fingerprint_profile_file": "/x"}, identity_api=True))
        assert a == b and a
        assert persona_avail({"fingerprint_profile": p2}) == \
            persona_avail({"fingerprint_profile": self.with_display(self.DISPLAY)})

    def test_explicit_wins_and_missing_display_leaves_scale_alone(self):
        from ant0browser._fingerprint import persona_avail, persona_dpr
        p = self.with_display(self.DISPLAY)
        assert persona_dpr({"device_pixel_ratio": 2, "fingerprint_profile": p}) == 2
        assert persona_avail({"avail_width": 1000, "fingerprint_profile": p})[0] == 1000
        assert persona_dpr({"fingerprint_profile": v4()}) is None
        assert persona_dpr({"fingerprint_profile": self.with_display({"device_pixel_ratio": 99})}) is None


class TestPersistentPersonaFileLifetime:
    @posix_only
    def test_persistent_context_removes_the_file_once_the_browser_is_up_and_on_failure(self, tmp_path, monkeypatch):
        import ant0browser as pkg

        class FakeContext:
            pages = []

            def on(self, name, fn):
                pass

        seen, outcome = [], {"fail": False}
        udd = tmp_path / "udd"

        class Chromium:
            def launch_persistent_context(self, user_data_dir, executable_path=None, args=None, **kw):
                seen.append(os.path.isfile(udd / PROFILE_FILE_NAME))  # there while the engine starts
                if outcome["fail"]:
                    raise RuntimeError("stop")
                return FakeContext()

        class PW:
            chromium = Chromium()

        monkeypatch.setattr(pkg, "_playwright", lambda: PW())
        engine = fake_engine(tmp_path, info([2, 4]))
        opts = {"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                "launch_ticket": False, "quiet": True, "headless": True}
        pkg.launch_persistent_context(str(udd), **dict(opts))
        assert seen == [True] and not (udd / PROFILE_FILE_NAME).exists()
        outcome["fail"] = True
        with pytest.raises(RuntimeError):
            pkg.launch_persistent_context(str(udd), **dict(opts))
        assert seen == [True, True] and not (udd / PROFILE_FILE_NAME).exists()

    @posix_only
    def test_a_terminate_signal_removes_the_temporary_persona_directory(self, tmp_path):
        import signal
        import subprocess
        import textwrap
        script = textwrap.dedent("""
            import os, signal, sys
            from ant0browser import _profile_file as pf
            probe = lambda _e: (True, '{"sdk_protocol": 2, "persona": {"schemas": [2, 4], "capabilities": ["display", "input"]}}')
            out = pf.stage_persona_profile({"fingerprint_profile": json_profile}, "/x/chrome", None, probe=probe,
                                           run=lambda *_: "", platform="linux")
            path = out["fingerprint_profile_file"]
            print(path, flush=True)
            os.kill(os.getpid(), signal.SIGTERM)
            import time; time.sleep(5)
        """)
        script = "import json\njson_profile = json.loads(%r)\n" % json.dumps(v4()) + script
        root = Path(__file__).resolve().parents[1]
        proc = subprocess.run([sys.executable, "-c", script], cwd=str(tmp_path), capture_output=True, text=True,
                              timeout=30, env={**os.environ, "PYTHONPATH": str(root)})
        path = proc.stdout.strip().splitlines()[0]
        assert proc.returncode == -signal.SIGTERM              # still ends the way SIGTERM would have
        assert not os.path.exists(path) and not os.path.exists(os.path.dirname(path))


class TestIncognitoPersonaFileLifetime:
    @posix_only
    def test_prepare_hands_the_temp_dir_to_the_launch_step(self, tmp_path):
        import ant0browser as pkg
        from ant0browser import _profile_file as pf
        engine = fake_engine(tmp_path, info([2, 4]))
        kwargs = {"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                  "launch_ticket": False, "quiet": True}   # no _ant0_user_data_dir: an incognito launch
        _, args, pw_kwargs, *_ = pkg._prepare(kwargs)
        tmp = pkg._take_persona_tmp(pw_kwargs)
        assert tmp and tmp in pf._live_temps
        assert any(a == f"--fingerprint-profile-file={tmp}/{PROFILE_FILE_NAME}" for a in args)
        assert "_ant0_persona_tmp" not in pw_kwargs
        pf.cleanup_persona_temp_dir(tmp)

    @posix_only
    def test_launch_removes_it_when_the_browser_disconnects_and_on_failure(self, tmp_path, monkeypatch):
        import ant0browser as pkg

        class FakeBrowser:
            contexts = []

            def __init__(self):
                self.handlers = {}

            def on(self, name, fn):
                self.handlers[name] = fn

            def new_page(self, **kw):
                return None

            def new_context(self, **kw):
                return None

        seen = []
        outcome = {"fail": False}

        class Chromium:
            def launch(self, executable_path=None, args=None, **kw):
                seen.append(next(a.split("=", 1)[1] for a in args if a.startswith("--fingerprint-profile-file=")))
                if outcome["fail"]:
                    raise RuntimeError("stop")
                return browser

        class PW:
            chromium = Chromium()

        browser = FakeBrowser()
        monkeypatch.setattr(pkg, "_playwright", lambda: PW())
        engine = fake_engine(tmp_path, info([2, 4]))
        opts = {"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                "launch_ticket": False, "quiet": True, "ephemeral_profile": False, "headless": True}
        got = pkg.launch(**dict(opts))
        assert got is browser
        assert not os.path.exists(seen[0])                      # the engine read it at startup: gone once the browser is up
        assert os.path.isdir(os.path.dirname(seen[0]))          # the temp dir stays until the browser closes
        browser.handlers["disconnected"]()
        assert not os.path.exists(os.path.dirname(seen[0]))
        outcome["fail"] = True
        with pytest.raises(RuntimeError):
            pkg.launch(**dict(opts))
        assert not os.path.exists(seen[1]) and not os.path.exists(os.path.dirname(seen[1]))  # a failed launch removes both

    @posix_only
    def test_persistent_context_with_an_empty_dir_uses_and_removes_a_private_temp_dir(self, tmp_path, monkeypatch):
        import ant0browser as pkg

        class FakeContext:
            pages = []

            def __init__(self):
                self.handlers = {}

            def on(self, name, fn):
                self.handlers[name] = fn

        ctx, seen = FakeContext(), []

        class Chromium:
            def launch_persistent_context(self, user_data_dir, executable_path=None, args=None, **kw):
                assert not any(k.startswith("_ant0") for k in kw)      # nothing internal reaches Playwright
                seen.append(next(a.split("=", 1)[1] for a in args if a.startswith("--fingerprint-profile-file=")))
                return ctx

        class PW:
            chromium = Chromium()

        monkeypatch.setattr(pkg, "_playwright", lambda: PW())
        monkeypatch.chdir(tmp_path)
        engine = fake_engine(tmp_path, info([2, 4]))
        got = pkg.launch_persistent_context("", identity={"mode": "captured", "source": v4()},
                                            executable_path=engine, launch_ticket=False, quiet=True, headless=True)
        assert got is ctx
        assert not seen[0].startswith(str(tmp_path)) and not os.path.exists(seen[0])  # file gone once up
        assert os.path.isdir(os.path.dirname(seen[0]))
        assert not (tmp_path / PROFILE_FILE_NAME).exists()
        ctx.handlers["close"]()
        assert not os.path.exists(os.path.dirname(seen[0]))


class TestReservedPersonaHandle:
    @posix_only
    def test_prepare_refuses_the_callers_persona_handle_and_never_emits_it(self, tmp_path):
        import ant0browser as pkg
        engine = fake_engine(tmp_path, info([2, 4]))
        for identity in ({"mode": "native"}, {"mode": "captured", "source": v4()}):
            with pytest.raises(Exception) as err:
                pkg._prepare({"identity": identity, "executable_path": engine, "launch_ticket": False,
                              "quiet": True, "args": ["--ant0-persona-handle=1:2"],
                              "_ant0_user_data_dir": str(tmp_path / "udd")})
            assert err.value.code == "sdk.launch_option_unsupported"
        assert not (tmp_path / "udd").exists()     # refused before anything was written
        _, args, pw, *_ = pkg._prepare({"identity": {"mode": "captured", "source": v4()}, "executable_path": engine,
                                        "launch_ticket": False, "quiet": True,
                                        "_ant0_user_data_dir": str(tmp_path / "udd")})
        assert not any("ant0-persona-handle" in a for a in args)
