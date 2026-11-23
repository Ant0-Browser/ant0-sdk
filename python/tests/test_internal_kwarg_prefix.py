import pathlib

import ant0browser


def test_no_legacy_private_kwarg_prefix_in_package_source():
    root = pathlib.Path(ant0browser.__file__).parent
    offenders = []
    for path in sorted(root.rglob("*.py")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "_cc_" in line:
                offenders.append(f"{path.relative_to(root)}:{n}")
    assert not offenders, f"legacy private kwarg prefix found: {offenders}"
