#!/usr/bin/env python3
"""Static guard for the DevTerm's Python 3.7 (Buster): parse every source with feature_version=(3, 7)
and flag standard-library APIs that only exist in 3.8+. Run with any Python >= 3.8.

    python3 apps/devterm/scripts/check_py37.py
"""
import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIRS = [os.path.join(ROOT, "src"), os.path.join(ROOT, "tests"), HERE]

# name -> first version that has it (attribute or keyword use we must not rely on)
NEWER_APIS = {
    r"\bshlex\.join\b": "3.8", r"\bcached_property\b": "3.8", r"\bmath\.prod\b": "3.8", r"\bmath\.isqrt\b": "3.8",
    r"\bmath\.dist\b": "3.8", r"\bimportlib\.metadata\b": "3.8", r"\bsocket\.create_server\b": "3.8",
    r"\bstatistics\.fmean\b": "3.8", r"\bunittest\.IsolatedAsyncioTestCase\b": "3.8", r"\bAsyncMock\b": "3.8",
    r"\baddClassCleanup\b": "3.8", r"\baddModuleCleanup\b": "3.8", r"missing_ok\s*=": "3.8", r"dirs_exist_ok\s*=": "3.8",
    r"\btyping\.(Literal|Protocol|TypedDict|Final)\b": "3.8", r"from typing import [^\n]*\b(Literal|Protocol|TypedDict|Final)\b": "3.8",
    r"\.removeprefix\(": "3.9", r"\.removesuffix\(": "3.9", r"\bzoneinfo\b": "3.9", r"\bset_escdelay\b": "3.9",
    r"\bget_escdelay\b": "3.9", r"\bis_relative_to\b": "3.9", r"\brandbytes\b": "3.9", r"BooleanOptionalAction": "3.9",
    r"\bfunctools\.cache\b": "3.9", r"\bas_integer_ratio\b": "3.8",
    r"\bitertools\.pairwise\b": "3.10", r"\bbit_count\(": "3.10", r"strict\s*=\s*True\s*\)": "3.10",
    r"\bhas_extended_color_support\b": "3.10", r"\baiter\(|\banext\(": "3.10", r"\bassertNoLogs\b": "3.10",
    r"\btomllib\b": "3.11", r"\benterContext\b": "3.11", r"\bExceptionGroup\b": "3.11",
    r"@(functools\.)?lru_cache\s*\n": "3.8 (bare @lru_cache)",
}
FSTRING_DEBUG = re.compile(r"""f(['"]).*?\{[^{}]*=\}.*?\1""")


def files():
    for d in DIRS:
        for base, dirs, fs in os.walk(d):
            dirs[:] = [x for x in dirs if x != "__pycache__"]
            for f in fs:
                if f.endswith(".py"):
                    yield os.path.join(base, f)


def main():
    if sys.version_info < (3, 8):
        print("run this checker with Python 3.8+ (it uses ast feature_version)")
        return 2
    bad = 0
    n = 0
    for path in sorted(files()):
        if os.path.abspath(path) == os.path.abspath(__file__):
            continue
        n += 1
        src = open(path, encoding="utf-8").read()
        rel = os.path.relpath(path, ROOT)
        try:
            ast.parse(src, filename=path, feature_version=(3, 7))
        except SyntaxError as e:
            print("%s:%s: not Python 3.7 syntax: %s" % (rel, e.lineno, e.msg))
            bad += 1
        for pat, ver in NEWER_APIS.items():
            for m in re.finditer(pat, src):
                line = src.count("\n", 0, m.start()) + 1
                print("%s:%d: uses %r (Python %s+)" % (rel, line, m.group(0).strip(), ver))
                bad += 1
        for i, line in enumerate(src.splitlines(), 1):
            if FSTRING_DEBUG.search(line):
                print("%s:%d: f-string '=' specifier (Python 3.8+)" % (rel, i))
                bad += 1
            if re.search(r"\(\s*\w+\s*:=", line) or re.search(r"\bif\s+\w+\s*:=", line):
                print("%s:%d: walrus operator (Python 3.8+)" % (rel, i))
                bad += 1
    print("checked %d files: %s" % (n, "OK for Python 3.7" if not bad else "%d problem(s)" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
