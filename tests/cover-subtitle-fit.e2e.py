# The cover slide's subtitle must fit its box by itself. Before the fix a long cover line overflowed at a fixed 22 pt,
# the quality check kept failing it, and the model shortened the words again and again without ever passing.
# Run: python3 tests/cover-subtitle-fit.e2e.py
import os, re, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
src = re.search(r'id="docs-py-src">\n(.*?)</script>', open(os.path.join(here, '..', 'sandbox-frame.html'), encoding='utf-8').read(), re.S).group(1)
tmp = tempfile.mkdtemp()
open(os.path.join(tmp, 'cognita_docs.py'), 'w', encoding='utf-8').write(src)
sys.path.insert(0, tmp)
os.chdir(tmp)
from cognita_docs import pptx, check  # noqa: E402

bad = 0
def t(name, ok):
    global bad
    print(name, 'OK' if ok else 'FAIL')
    if not ok:
        bad += 1

def report(blocks, name):
    pptx(name, blocks)
    return check(name)

long_sub = ("Prepared for the Independent Electoral Commission by Manik Multifunctional Company, Ikeja, Lagos. "
            "Proposal for the setup and operation of a 40 seat voter engagement call centre")
rep = report([("title", "Armoury for KOH Lagos Call Center Proposal"), ("p", long_sub),
              ("p", "Confidential: submitted October 2026 for evaluation"),
              ("h1", "1. Overview"), ("p", "The call centre reports to the Campaign Director.")], "long-sub.pptx")
t('long cover subtitle passes the check', 'PASS' in rep and 'Subtitle' not in rep)

rep = report([("title", "Short title"), ("p", "One short line"), ("h1", "1. Overview"), ("p", "Body.")], "short-sub.pptx")
t('short cover subtitle still passes', 'PASS' in rep)

rep = report([("title", "A very long proposal title for the armoury call centre operations and voter engagement programme "
                         "across all local government areas of Lagos State, covering staffing, training and quality assurance"),
              ("p", "Sub"), ("h1", "1. Overview"), ("p", "Body.")], "long-title.pptx")
t('long cover title and footer do not overflow', "'Title" not in rep and 'Footer' not in rep)

sys.exit(1 if bad else 0)
