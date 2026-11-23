"""Stable error identity for SDK failures.

Every SDK error carries a ``code`` (a fixed dotted word), an ``error_class`` (``defect``,
``environment`` or ``expected``) and an optional local ``cause``. Nothing here reports,
logs or sends anything: the SDK stays offline. ``report_fields()`` returns the only two
values that are safe to forward to a reporter; messages and causes may hold paths or values
and must never be forwarded.

The classes subclass the builtin types the SDK raised before, so ``except ValueError`` and
friends keep working.
"""

import builtins
import re

DEFECT = "defect"
ENVIRONMENT = "environment"
EXPECTED = "expected"


def _rebuild(cls, args, state):
    """Pickle/copy helper: restore an error without calling its ``__init__``."""
    obj = cls.__new__(cls, *args)
    obj.args = args
    obj.__dict__.update(state)
    return obj


class Coded:
    """Mixin giving an exception a stable ``code`` and ``error_class``."""

    code = "sdk.error"
    error_class = DEFECT

    def __reduce__(self):
        # Keeps message, code and fields through pickle, copy and deepcopy. The cause is local
        # only and is deliberately not carried along.
        return (_rebuild, (type(self), self.args, dict(self.__dict__)))

    @property
    def cause(self):
        """The underlying exception, kept in this process only."""
        return self.__cause__

    def report_fields(self) -> dict:
        return {"code": str(self.code), "class": self.error_class}


class SdkError(Coded):
    """Mixin for errors raised as ``Cls(code, message, cause=None, error_class=None)``."""

    def __init__(self, code, *args, cause=None, error_class=None):
        super().__init__(*args)
        self.code = code
        if error_class is not None:
            self.error_class = error_class
        if cause is not None:
            self.__cause__ = cause


class SdkValueError(SdkError, ValueError):
    """Invalid value passed to the SDK."""

    error_class = EXPECTED


class SdkTypeError(SdkError, TypeError):
    """Wrong type passed to the SDK."""

    error_class = EXPECTED


class SdkRuntimeError(SdkError, builtins.RuntimeError):
    """An environment failure (missing binary, bad download, no browser engine)."""

    error_class = ENVIRONMENT
