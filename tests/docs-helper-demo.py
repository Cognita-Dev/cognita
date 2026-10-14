import sys; import re,sys,os;os.makedirs('/tmp',exist_ok=True);open('/tmp/cognita_docs.py','w').write(re.search(r'id="docs-py-src">\n(.*?)</script>',open(os.path.join(os.path.dirname(__file__),'..','sandbox-frame.html')).read(),re.S).group(1));sys.path.insert(0,'/tmp')
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from cognita_docs import docx, pdf, pptx
fig, ax = plt.subplots(figsize=(8,4.6)); ax.axis("off"); ax.set_xlim(0,10); ax.set_ylim(0,6)
def box(x,y,t,c):
    ax.add_patch(FancyBboxPatch((x-1.1,y-.4),2.2,.8,boxstyle="round,pad=0.05",fc=c,ec="#1f2937"))
    ax.text(x,y,t,ha="center",va="center",fontsize=8,color="white",weight="bold")
box(5,5.3,"Campaign Director","#0f766e")
box(5,3.8,"Call Centre Manager","#1d4ed8")
for x,t in [(1.8,"Team Leads"),(5,"Training & QA"),(8.2,"Data & CRM")]:
    ax.plot([5,5,x,x],[3.4,3.1,3.1,2.6],c="#1f2937"); box(x,2.2,t,"#7c3aed")
for x in (1.8,):
    ax.plot([x,x],[1.8,1.4],c="#1f2937"); box(x,1,"Call Agents","#b45309")
ax.plot([5,5],[4.9,4.2],c="#1f2937")
fig.savefig("/tmp/org.png",dpi=150,bbox_inches="tight",transparent=False)
fig.savefig("/tmp/org_a.png",dpi=100,transparent=True)
b=[("title","Project Olóore — Voter Engagement Call Centre"),("h1","1. Organisation"),("p","The call centre reports to the **Campaign Director**."),
("image","/tmp/org.png",{"width":400,"caption":"Figure 1: Organogram"}),("image","/tmp/org_a.png",{"width":300}),
("h1","2. Roles"),("bullets",["Manager","Team leads"]),("table",[["Role","Count"],["Agents","40"]]),("image","/nope.png")]
docx("demo.docx",b);pdf("demo.pdf",b);pptx("demo.pptx",b);print("built")
