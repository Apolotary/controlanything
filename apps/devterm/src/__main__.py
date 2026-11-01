# zipapp entry point: python3 ce-devterm.pyz [args]
import sys

if sys.version_info < (3, 7):
    sys.stderr.write("ce-devterm needs Python 3.7 or newer (this is %d.%d)\n" % sys.version_info[:2])
    sys.exit(2)

from ce_devterm.cli import main  # noqa: E402

sys.exit(main())
