import json, os, math, sys
OUT=sys.argv[1]
def svg(body): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n<g fill="#ffffff">{body}</g>\n</svg>\n'
def rgb(h,a=1):
    h=h.lstrip('#'); r,g,b=[int(h[i:i+2],16)/255 for i in (0,2,4)]; return f"srgb:{r:.5f},{g:.5f},{b:.5f},{a:.5f}"
def gray(v): return f"extended-gray:{v:.5f},1.00000"
def grad(t,b): return {"linear-gradient":[rgb(t),rgb(b)],"orientation":{"start":{"x":0.5,"y":0},"stop":{"x":0.5,"y":1}}}
def layer(name,light,dark=None,tint=1.0,opacity=None):
    f=[{"value":{"solid":rgb(light)}}]
    if dark: f.append({"appearance":"dark","value":{"solid":rgb(dark)}})
    f.append({"appearance":"tinted","value":{"solid":gray(tint)}})
    L={"name":name,"image-name":name+".svg","glass":True,"fill-specializations":f}
    if opacity is not None: L["opacity"]=opacity
    return L
def group(name,layers,transl=0.4,shadow=0.5):
    return {"name":name,"layers":layers,"lighting":"combined","shadow":{"kind":"neutral","opacity":shadow},
            "specular":True,"translucency":{"enabled":True,"value":transl}}
def chevron(cx,cy,s,w):
    # ">" as a filled capsule polyline: two strokes meeting at the tip
    a=(cx-s*0.5,cy-s); tip=(cx+s*0.5,cy); b=(cx-s*0.5,cy+s)
    return cap(*a,*tip,w)+cap(*tip,*b,w)
def cap(x1,y1,x2,y2,w):
    r=w/2; dx,dy=x2-x1,y2-y1; L=math.hypot(dx,dy); nx,ny=-dy/L*r,dx/L*r
    f=lambda v:f"{v:.2f}"
    return (f'<path d="M{f(x1+nx)} {f(y1+ny)}L{f(x2+nx)} {f(y2+ny)}A{r} {r} 0 0 0 {f(x2-nx)} {f(y2-ny)}'
            f'L{f(x1-nx)} {f(y1-ny)}A{r} {r} 0 0 0 {f(x1+nx)} {f(y1+ny)}Z"/>')
def write(cname,bg,bgdark,groups,files):
    d=os.path.join(OUT,cname+".icon"); os.makedirs(d+"/Assets",exist_ok=True)
    for n,b in files.items(): open(f"{d}/Assets/{n}.svg","w").write(svg(b))
    j={"fill-specializations":[{"value":grad(*bg)},{"appearance":"dark","value":grad(*bgdark)}],
       "groups":groups,"supported-platforms":{"squares":"shared"}}
    open(d+"/icon.json","w").write(json.dumps(j,indent=2))

# A: glass terminal window with a prompt
write("A-window",("#5b5ff0","#1c1a5e"),("#26264a","#07070f"),
 [group("Prompt",[layer("prompt","#5ef2b0","#5ef2b0",1.0)],0.1),
  group("Window",[layer("window","#ffffff","#c9cdf0",0.6)],0.55)],
 {"window":'<path fill-rule="evenodd" d="M262 232H762A80 80 0 0 1 842 312V712A80 80 0 0 1 762 792H262A80 80 0 0 1 182 712V312A80 80 0 0 1 262 232Z"/>',
  "prompt":chevron(372,512,92,58)+'<rect x="500" y="580" width="170" height="56" rx="28"/>'})

# B: tmux panes
write("B-panes",("#1fb8a6","#0b3d5c"),("#173238","#04090c"),
 [group("Cursor",[layer("cursor","#ffffff","#e9fffb",1.0)],0.1),
  group("Panes",[layer("pane-left","#ffffff","#bfeee8",0.9,0.95),
                 layer("pane-top","#ffd36b","#ffcf5c",0.65),
                 layer("pane-bottom","#ff7a8a","#ff6f80",0.45)],0.45)],
 {"pane-left":'<rect x="176" y="196" width="384" height="632" rx="64"/>',
  "pane-top":'<rect x="592" y="196" width="256" height="300" rx="56"/>',
  "pane-bottom":'<rect x="592" y="528" width="256" height="300" rx="56"/>',
  "cursor":""})
# B cursor is drawn dark-on-light: use a colored layer instead
p="/".join([OUT,"B-panes.icon"])
open(p+"/Assets/cursor.svg","w").write(svg(chevron(300,450,58,40)+'<rect x="380" y="490" width="100" height="40" rx="20"/>'))
j=json.load(open(p+"/icon.json")); j["groups"][0]["layers"][0]=layer("cursor","#0b3d5c","#0b3d5c",0.3); open(p+"/icon.json","w").write(json.dumps(j,indent=2))

# C: ripples spreading from a prompt
rings=""
for r,w in [(170,44),(285,40),(400,36)]:
    rings+=f'<path fill-rule="evenodd" d="M{512-r} 512a{r} {r} 0 1 0 {2*r} 0a{r} {r} 0 1 0 {-2*r} 0Z M{512-r+w} 512a{r-w} {r-w} 0 1 0 {2*(r-w)} 0a{r-w} {r-w} 0 1 0 {-2*(r-w)} 0Z"/>'
write("C-ripple",("#3aa0ff","#2234c9"),("#1b2450","#05060f"),
 [group("Prompt",[layer("prompt","#ffffff","#ffffff",1.0)],0.1),
  group("Ripples",[layer("ripples","#ffffff","#a9c8ff",0.7,0.9)],0.6)],
 {"ripples":rings,"prompt":chevron(480,512,52,38)+'<rect x="530" y="548" width="78" height="36" rx="18"/>'})

# D: bold chevron + cursor, nothing else
write("D-prompt",("#ff9a3c","#ff3d6e"),("#3a1b24","#0b0507"),
 [group("Cursor",[layer("cursor","#ffffff","#ffb36b",0.8)],0.3),
  group("Chevron",[layer("chevron","#ffffff","#ffffff",1.0)],0.35)],
 {"chevron":chevron(400,512,190,120),"cursor":'<rect x="560" y="640" width="250" height="100" rx="50"/>'})
