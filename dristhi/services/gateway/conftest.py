import os
import sys

# Tests always use the in-memory store: never touch a real Postgres.
os.environ["DATABASE_URL"] = ""
os.environ.setdefault("DRISHTI_IOT_MODE", "off")

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# The robot's reference client (robot/drishti_link.py) is exercised against the
# real gateway code to prove the two ends interoperate.
sys.path.append(os.path.join(_ROOT, "robot"))
