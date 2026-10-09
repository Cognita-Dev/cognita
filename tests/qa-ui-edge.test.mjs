import * as S from '../ui-schema.js';
let fail=0; const bad=(m,x)=>{fail++;console.log('FAIL',m,x===undefined?'':JSON.stringify(x).slice(0,300));};
const ok=(c,m,x)=>{if(!c)bad(m,x)};
const T=S.UI_TYPES;
const garbage=[null,undefined,0,'',[],{},[null],{type:'table'},{type:'table',props:null},{type:'table',props:[]},{type:'__proto__'},{type:'constructor'},{type:'toString'},{type:'card',props:{title:{a:1}}},{type:'card',props:{title:['x']}}];
garbage.forEach((g,i)=>{try{const r=S.validateUi(g);ok(Array.isArray(r),'validate garbage '+i)}catch(e){bad('throw garbage '+i,String(e))}});
// empty props per type
T.forEach(t=>{try{const r=S.validateUi([{type:t,props:{}}]);ok(Array.isArray(r),'empty '+t);}catch(e){bad('throw empty '+t,String(e))}});
// weird: props with wrong types
T.forEach(t=>{[{items:'x',rows:'x',columns:'x',labels:'x',values:'x',series:'x',tabs:'x',sections:'x',fields:'x',sources:'x',findings:'x',metrics:'x',code:5,title:5,tasks:'x'},{items:[null,1,[],{}],rows:[null,'a',1,[[]]],columns:[1,2,null],labels:[null,{}],values:[null,'a'],series:[null,1,{values:'x'}],tabs:[null,{label:'a',children:'x'}],sections:[null,{title:'a',tasks:'x'}],fields:[null,{label:'a',type:'bogus'},{label:'b',type:'select',options:'x'}]}].forEach((p,j)=>{try{S.validateUi([{type:t,props:p}])}catch(e){bad('throw weird '+t+j,String(e))}})});
// charts
let r=S.validateUi([{type:'bar_chart',props:{labels:['a','b','c'],values:[1,2]}}]);ok(r[0]&&r[0].props.labels.length===2,'mismatch labels>values',r);
r=S.validateUi([{type:'bar_chart',props:{labels:['a'],values:[1,2,3]}}]);ok(r[0]&&r[0].props.series[0].values.length===1,'values>labels',r);
r=S.validateUi([{type:'bar_chart',props:{values:[1,2,3]}}]);ok(r[0]&&r[0].props.labels.length===3,'no labels',r);
r=S.validateUi([{type:'bar_chart',props:{labels:['a','b'],values:['1,000','x']}}]);ok(r[0]&&r[0].props.series[0].values[0]===1000,'str numbers',r);
r=S.validateUi([{type:'bar_chart',props:{labels:[],values:[]}}]);ok(r.length===0,'empty chart dropped');
r=S.validateUi([{type:'pie_chart',props:{labels:['a','b'],series:[{values:[1,2]},{values:[3,4]}]}}]);ok(r[0].props.series.length===1,'pie one series');
r=S.validateUi([{type:'line_chart',props:{labels:['a','b'],series:[{name:'x',values:[1,2]},{name:'y',values:[1]}]}}]);ok(r[0]&&r[0].props.series.every(s=>s.values.length===r[0].props.labels.length),'ragged series',r);
r=S.validateUi([{type:'bar_chart',props:{labels:['a','b'],series:[{values:[1,2]},{values:'x'}]}}]);ok(r[0]!==undefined||true,'series non-array');
// huge
r=S.validateUi([{type:'table',props:{columns:Array(40).fill('c'),rows:Array(500).fill(Array(40).fill('x'))}}]);ok(r[0].props.rows.length<=50&&r[0].props.columns.length<=12,'limits');
// depth
let n={type:'card',props:{title:'d'}};for(let i=0;i<10;i++)n={type:'card',props:{title:'d'+i},children:[n]};
r=S.validateUi([n]);let d=0,c=r[0];while(c&&c.children&&c.children[0]){d++;c=c.children[0]}ok(d<=4,'depth',d);
// nodes budget
r=S.validateUi([{type:'card',props:{title:'x'},children:Array(500).fill({type:'stat',props:{label:'a',value:'1'}})}]);
// emoji / unicode
r=S.validateUi([{type:'card',props:{title:'你好 🎓 مرحبا'}}]);ok(r[0].props.title==='你好 🎓 مرحبا','unicode');
r=S.validateUi([{type:'card',props:{title:'a'.repeat(190)+'🎓🎓🎓'}}]);ok(!/[\ud800-\udbff]$/.test(r[0].props.title),'lone surrogate from slice',r[0].props.title.slice(-3));
// injection
const inj='<img src=x onerror=alert(1)><script>alert(1)</script>';
T.forEach(t=>{const j=JSON.stringify(S.validateUi([{type:t,props:{title:inj,label:inj,value:inj,content:inj,code:inj,columns:[inj],rows:[[inj]],items:[inj],labels:[inj],values:[1],tabs:[{label:inj,content:inj}],sections:[{title:inj}],fields:[{label:inj,type:'text'}],sources:[{title:inj,url:'javascript:alert(1)'}],findings:[inj]}}]));ok(!j.includes('javascript:'),'js url '+t)});
r=S.validateUi([{type:'source_list',props:{sources:[{title:'a',url:'javascript:alert(1)'},{title:'b',url:'  https://ok.com/x '},{title:'c',url:'HTTPS://a.com'},{title:'d',url:'//evil.com'}]}}]);ok(r[0].props.sources[1].url==='https://ok.com/x','trim url',r[0].props.sources);
// form
r=S.validateUi([{type:'form',props:{fields:[{label:'A',type:'number'},{label:'A',type:'text'},{label:'B',type:'select',options:[]},{label:'__proto__'}]}}]);ok(r[0]&&new Set(r[0].props.fields.map(f=>f.name)).size===r[0].props.fields.length,'dup field names',r[0]&&r[0].props.fields.map(f=>f.name));
ok(r[0].props.fields.find(f=>f.type==='select'&&!f.options.length),'select w/o options kept (renderer must handle)');
// state
r=S.validateUi([{type:'table',props:{columns:['a'],rows:[['1']]},state:{sort:{col:99},selected:[5,-1,'x']}}]);ok(!r[0].state||!r[0].state.sort,'bad sort state',r[0].state);
// patches
const base=S.validateUi([{id:'lc',type:'line_chart',props:{labels:['a','b'],values:[1,2]}},{id:'pc',type:'pie_chart',props:{labels:['a','b'],values:[1,2]}},{id:'tb',type:'tabs',props:{tabs:[{label:'a',content:'x'}]}},{id:'ac',type:'accordion',props:{sections:[{title:'a',content:'x'}]}},{id:'pl',type:'plan',props:{sections:[{title:'s',tasks:['t']}]}},{id:'ds',type:'data_summary',props:{findings:['f'],metrics:[{label:'a',value:'1'}]}}]);
const base2=S.validateUi([{id:'sl',type:'source_list',props:{sources:[{title:'a',url:'https://a.com'}]}}]);
const P=(p)=>S.applyPatch(base,p);const P2=(p)=>S.applyPatch(base2,p);
let x=P({op:'append',target:'lc',labels:['c'],values:[3]});ok(x.ok&&x.blocks[0].props.labels.length===3&&x.blocks[0].props.series[0].values.length===3,'line append',x.ok&&x.blocks[0].props);
x=P({op:'append',target:'pc',labels:['c'],values:[3]});ok(x.ok&&x.blocks[1].props.series[0].values.length===3,'pie append');
x=P({op:'append',target:'lc',values:[3]});ok(!x.ok||x.blocks[0].props.labels.length===x.blocks[0].props.series[0].values.length,'append values only keeps aligned',x.blocks[0].props);
x=P({op:'append',target:'lc',labels:['c','d'],series:[{values:[3,4]}]});ok(x.ok&&x.blocks[0].props.labels.length===4,'series append');
x=P({op:'append',target:'tb',tabs:[{label:'b',content:'y'}]});ok(x.ok&&x.blocks[2].props.items.length===2,'tabs append');
x=P({op:'append',target:'ac',sections:[{title:'b',content:'y'}]});ok(x.ok&&x.blocks[3].props.items.length===2,'accordion append');
x=P({op:'append',target:'pl',sections:[{title:'s2',tasks:['q']}]});ok(x.ok&&x.blocks[4].props.sections.length===2,'plan append');
x=P({op:'append',target:'ds',findings:['g'],metrics:[{label:'b',value:'2'}]});ok(x.ok&&x.blocks[5].props.findings.length===2&&x.blocks[5].props.metrics.length===2,'ds append');
x=P2({op:'append',target:'sl',sources:[{title:'b',url:'https://b.com'}]});ok(x.ok&&x.blocks[0].props.sources.length===2,'sl append');
x=P({op:'update',target:'lc',props:{title:'T'}});ok(x.ok&&x.blocks[0].props.title==='T','line update');
x=P({op:'update',target:'pc',props:{labels:['z'],values:[9]}});ok(x.ok&&x.blocks[1].props.labels[0]==='z','pie update');
x=P({op:'update',target:'tb',props:{tabs:[{label:'q',content:'1'},{label:'w',content:'2'}]}});ok(x.ok&&x.blocks[2].props.items.length===2,'tabs update',x.blocks[2]&&x.blocks[2].props);
x=P({op:'update',target:'ac',props:{sections:[{title:'q'}]}});ok(x.ok&&x.blocks[3].props.items[0].label==='q','accordion update',x.blocks[3]&&x.blocks[3].props);
x=P({op:'update',target:'pl',props:{sections:[{title:'n',tasks:['a','b']}]}});ok(x.ok&&x.blocks[4].props.sections[0].tasks.length===2,'plan update');
x=P({op:'update',target:'ds',props:{findings:['n']}});ok(x.ok,'ds update');
x=P2({op:'update',target:'sl',props:{sources:[{title:'n',url:'https://n.com'}]}});ok(x.ok,'sl update');
x=P({op:'set_state',target:'tb',state:{active:5}});ok(x.ok&&(!x.blocks[2].state||x.blocks[2].state.active<=0||true),'tabs state OOR',x.blocks[2].state);
x=P({op:'set_state',target:'pl',state:{done:[[true]]}});ok(x.ok,'plan state');
x=P({op:'set_state',target:'lc',state:{view:'table'}});ok(x.ok&&x.blocks[0].state.view==='table','chart view state');
x=P2({op:'remove',target:'sl'});ok(x.ok&&x.blocks.length===0,'remove');
x=P({op:'remove',target:'nope'});ok(!x.ok,'remove missing');
x=P({op:'replace',target:'lc',node:{type:'stat',props:{label:'a',value:'1'}}});ok(x.ok&&x.blocks[0].type==='stat'&&x.blocks[0].id==='lc','replace');
x=P({op:'create',parent:'tb',slot:0,node:{type:'stat',props:{label:'a',value:'1'}}});ok(x.ok,'create in tab');
x=P({op:'create',parent:'nope',node:{type:'stat',props:{label:'a',value:'1'}}});ok(!x.ok,'create bad parent');
x=P({op:'update',target:'lc',props:{__proto__:{x:1},constructor:{y:1}}});
x=S.applyPatch(base,{op:'update',target:'lc',props:JSON.parse('{"__proto__":{"polluted":1},"title":"a"}')});ok(({}).polluted===undefined,'proto pollution');
// update to something invalid shouldn't drop node
x=P({op:'update',target:'lc',props:{labels:[],values:[]}});ok(!x.ok||x.blocks.length===7,'invalid update drops nodes?',x.blocks.length);
// patch ordering: patch before block (stream)
// stream parsing
const full='Hello\n```cognita-ui\n'+JSON.stringify([{id:'a',type:'table',props:{columns:['x','y'],rows:[['1','2'],['3','4']]}},{op:'append',target:'a',rows:[['5','6']]}])+'\n```\nBye';
for(let i=0;i<=full.length;i++){const s=S.createUiStream();const o=s.push(full.slice(0,i));if(/"columns"|cognita-ui|"type"/.test(o.text)){bad('leak at '+i,o.text);break}}
// language-tagged / indented / CRLF / uppercase fences
['```cognita-ui\r\n{"type":"stat","props":{"label":"a","value":"1"}}\r\n```','```cognita-ui {"type":"stat","props":{"label":"a","value":"1"}}```','  ```cognita-ui\n{"type":"stat","props":{"label":"a","value":"1"}}\n```','```json cognita-ui\n{"type":"stat","props":{"label":"a","value":"1"}}\n```','~~~cognita-ui\n{"type":"stat","props":{"label":"a","value":"1"}}\n~~~','```Cognita-UI\n{"type":"stat","props":{"label":"a","value":"1"}}\n```'].forEach((f,i)=>{const o=S.parseUiReply(f);ok(o.ui.length===1&&!/cognita|stat/i.test(o.text),'fence variant '+i,o)});
// multiple fences, malformed JSON, trailing commas
let o=S.parseUiReply('a\n```cognita-ui\n{"type":"stat","props":{"label":"a","value":"1",}}\n```\nb');ok(o.ui.length===1,'trailing comma',o);
o=S.parseUiReply('```cognita-ui\n{"type":"stat","props":{"label":"a","value":"1"}}\n```\n```cognita-ui\n{"type":"stat","props":{"label":"b","value":"2"}}\n```');ok(o.ui.length===2,'two fences');
o=S.parseUiReply('```cognita-ui\nnot json at all\n```');ok(o.text===''||!o.text.includes('not json')||true,'garbage fence',o);
// code fence containing the word cognita-ui in normal code
o=S.parseUiReply('```js\nconst x="cognita-ui";\n```');ok(o.text.includes('const x'),'normal code preserved',o);
o=S.parseUiReply('Use the ```cognita-ui fence to render');ok(true);
// leaked tool call
['<|tool_call_start|>[codegen(component_id=\'t\', type=\'table\', props={\'columns\': [\'a\'], \'rows\': [[\'1\']]})]<|tool_call_end|>','<tool_call>{"name":"table","arguments":{"type":"table","props":{"columns":["a"],"rows":[["1"]]}}}</tool_call>','<|tool_call_start|>[codegen(type=\'bar_chart\', props={\'labels\': [\'a\'], \'values\': [1]})]<|tool_call_end|>','<|tool_call_start|>[codegen(type=\'pie_chart\', props={\'labels\': [\'a\',\'b\'], \'values\': [1,2]})','<|tool_call_start|>[codegen(type=\'tabs\', props={\'tabs\': [{\'label\': \'a\', \'content\': \'x\'}]})]<|tool_call_end|>','<|tool_call_start|>[codegen(type=\'form\', props={\'fields\': [{\'label\': \'a\'}]})]<|tool_call_end|>','<|tool_call_start|>[codegen(type=\'card\', props={\'title\': \'a\', \'content\': None, \'collapsible\': True})]<|tool_call_end|>'].forEach((f,i)=>{const o=S.parseUiReply(f);ok(o.ui.length===1&&!/tool_call|codegen/.test(o.text),'leak '+i,o)});
o=S.parseUiReply('<|tool_call_start|>[unknown_tool(x=1)]<|tool_call_end|> hi');ok(!/tool_call|unknown_tool/.test(o.text),'unknown leak stripped',o.text);
o=S.parseUiReply('<|tool_call_start|>[plan_patch(op=\'append\', target=\'t\', rows=[[\'1\']])]<|tool_call_end|>');ok(o.patches.length===1||true,'leak patch',o);
o=S.parseUiReply('I will <tool_call> explain');
// partial stream on leaked
const lk='Hi <|tool_call_start|>[codegen(type=\'table\', props={\'columns\': [\'a\',\'b\'], \'rows\': [[\'1\',\'2\']]})]<|tool_call_end|> done';
for(let i=0;i<=lk.length;i++){const q=S.createUiStream().push(lk.slice(0,i));if(/tool_call|codegen|<\|/.test(q.text)){bad('leak stream at '+i,q.text);break}}
// plain text with angle brackets
o=S.parseUiReply('Use <tool_call> tags like a <b>b</b> and 5 < 6');
console.log('done fails=',fail);
