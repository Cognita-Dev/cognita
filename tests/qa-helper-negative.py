import sys,re
src=open(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','sandbox-frame.html')).read()
open('/tmp/cognita_docs.py','w').write(re.search(r'id="docs-py-src">\n(.*?)</script>',src,re.S).group(1)); sys.path.insert(0,'/tmp')
from cognita_docs import *
from PIL import Image, ImageDraw
long="This is a very long sentence that keeps going and going without any real point at all. "*8
pptx("/tmp/bad.pptx",[("title","Bad deck"),("h1","Overstuffed"),("p",long*3),("h1","Leak"),("bullets",["**Bold** ok","## heading leaked","TBD later"])])
pdf("/tmp/bad.pdf",[("title","T"),("h1","S"),("image","/nope.png"),("p","**oops**")])
docx("/tmp/bad.docx",[("p","**x** lorem ipsum"),("image","/nope.png")])
Image.new("RGB",(300,200),"white").save("/tmp/blank.png")
im=Image.new("RGB",(900,600),"white");ImageDraw.Draw(im).rectangle([0,100,900,500],fill="red");im.save("/tmp/clip.png")
for f in ("/tmp/blank.png","/tmp/clip.png","/tmp/missing.pptx"): print(check(f))
