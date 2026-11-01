PY ?= python3

.PHONY: test check build crosscheck demo

test:
	$(PY) -m unittest discover -s tests

check: test
	$(PY) scripts/check_py37.py

build: check
	$(PY) scripts/build.py

# dev-only: module-for-module comparison with the JS qrcode package (needs node + the repo's node_modules)
crosscheck:
	$(PY) scripts/qr_crosscheck.py

# the terminal UI against `npm run dev` on this machine
demo:
	$(PY) dist/ce-devterm.pyz --demo
