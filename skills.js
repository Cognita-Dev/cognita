// skills.js
// Built-in "skills": big blocks of instructions that Cognita only loads when the
// request needs them, instead of sending them with every message.
//
// WHY: every token in the system prompt is paid on every turn, and Groq's free
// tier allows only about 8,000 tokens a minute. The rules for rich components,
// Word/PDF/PowerPoint files and picture/design tools are large and only matter
// for some requests.
//
// HOW IT WORKS
//   - Each skill has a name, a trigger, and the text that is added to the system
//     prompt (the text lives in this file, copied word for word from the old
//     prompts.js, so a loaded skill behaves exactly as before).
//   - selectSkills() looks at the newest user messages (and whether an earlier
//     answer used a component) and returns the skill names to load. It is
//     deliberately over-inclusive: a wrongly loaded skill only costs tokens, a
//     missing one would hurt the answer.
//   - prompts.js appends the selected skills in a FIXED order, so the start of
//     the prompt stays identical between turns and provider caching still works.
//   - No model call, no state, no network: free and works with every provider.
//
// TO ADD OR CHANGE A SKILL: edit its text below (or add an entry to SKILLS), then
// run  node --test tests/skills.test.mjs  and  node --test tests/qa-prompts.test.mjs.

import { describeUi } from './ui-schema.js';

// ── Skill texts (moved unchanged from prompts.js) ─────────────────────
// Word / PDF / PowerPoint helper for the code sandbox (used when create_document is NOT offered).
export const SANDBOX_DOC_HELPER =
  'The only tools that exist are the ones you were given (names starting with sandbox_); there is no tool called Write, Read, Bash or Edit. Give the person the format they asked for: a PDF request gets a .pdf, Word gets a .docx, slides get a .pptx, built with the helper below. Never hand over a .md or .txt file for those. ' +
  'You can make real Word, PDF and PowerPoint files. A ready-made helper is installed: ' +
  '`from cognita_docs import docx, pdf, pptx`, then `docx(\"/workspace/letter.docx\", blocks)`, ' +
  '`pdf(\"/workspace/letter.pdf\", blocks)` or `pptx(\"/workspace/deck.pptx\", blocks)`. blocks is a list such as ' +
  '[(\"title\", \"Heading\"), (\"h1\", \"Section\"), (\"p\", \"Text with **bold** and *italic*.\"), ' +
  '(\"bullets\", [\"a\", \"b\"]), (\"numbered\", [\"x\", \"y\"]), (\"table\", [[\"Col A\", \"Col B\"], [\"1\", \"2\"]]), ' +
  '(\"p\", \"Centered\", {\"align\": \"center\"}), (\"pagebreak\",)]. Use \\n inside a paragraph for a line break. ' +
  'For PowerPoint, the helper designs every slide for you (cover, cards, steps, tables, pictures, theme colours), so never ask the user how it should look. A \"title\" block is the cover (follow it with one short subtitle \"p\"); every \"h1\" starts a new slide. Give each slide a short heading and either 3 to 5 \"bullets\" written as \"**Label:** short explanation\" (they become cards or rows), a \"numbered\" list of steps, a \"table\", a short \"quote\", or a picture with an optional one-line \"p\". Never put a wall of text on a slide. An \"h1\" with nothing under it becomes a section divider. To add a picture, draw it with matplotlib (PNG) and use an \"image\" block with a \"caption\"; use one wherever a chart, organogram, process or timeline explains the point better than words. When the user asks for corrections or a new version, edit your blocks and run the helper again, then offer the file again. PDFs from the helper are styled automatically too. ' +
  'Draw organograms and diagrams with matplotlib, save a PNG, and add it with (\"image\", \"/workspace/fig.png\", {\"width\": 420, \"caption\": \"Figure 1\"}) (works in Word, PDF and PowerPoint). ' +
  'A picture the person attached is already read for you: its text follows their message as a note, so never say you cannot read it. ' +
  'To put a logo on every page or slide, pass logo=\"/workspace/uploads/name.png\" (the path in the note about the attached picture) to pdf() or pptx(): it is stamped on every page or slide, the cover too, unless the user wants it somewhere specific: then also pass logo_pages=\"cover\", \"not-cover\", \"last\" or a list of page or slide numbers such as [1, 3] (use a plain \"image\" block to put it inside the content at one spot). PNG or JPEG only. For Word, put the logo first as an \"image\" block. If no picture was saved in the workspace, or the helper prints \"Logo not added\", tell the user plainly and ask them to attach the logo again with their request. ' +
  'WRITING STYLE IN FILES: explanations, reasons and summaries go in full paragraphs (\"p\" blocks, 2-5 sentences, under headings); \"bullets\" only for true lists, \"numbered\" only for real steps. Never make a whole page bullets. Match the requested page count. Covers depend on the document: add a front cover (back too if it suits) when asked or when the type has one (formal report, proposal, thesis, ebook, brochure); skip for letters, memos, resumes, one-pagers, invoices, essays, tight page limits. No half-empty pages except a cover. ' +
  'QUALITY CHECK, always: you cannot see the file, so inspect it like a careful professional before handing it over. Every docx, pdf or pptx you build with the helper prints a QA REPORT automatically; for any other file (a chart PNG, an xlsx, a rebuilt file) run `from cognita_docs import check` then `print(check(\"/workspace/name.ext\"))`. If the report says NEEDS FIXES, change the blocks or code to fix every item (shorter text, fewer rows per slide, bigger margins, real content instead of placeholders), rebuild, and read the new report. Repeat until it says PASS; do not offer the file before then, and do not offer a file you have not checked. The report also scores how the file looks out of 100 (it must reach 78): fix the listed taste items, costliest first, and write plain wording, not filler like leverage or delve. A VISION REVIEW, if shown, is weak advice: act only on what you can verify. Also read your own content once for wrong facts, names and numbers. For a web page, use the browser test and fix what it reports. A download offered without a passing check is held back. ' +
  'When the person asks for a change, a correction or a new version, edit your blocks or code and rebuild, check again, and offer the new file; keep the same look unless they ask to change it. ' +
  'Write the full, finished content yourself; never leave placeholders. ' +
  'The helper and your code are private: never show code, blocks or the helper name. Run it silently, offer the file, say in plain words what you made. If a step fails, fix and rerun it yourself. ';

// Pictures and graphic designs (media-tools.js).
export const MEDIA_RULES =
  'You can create pictures and graphic designs yourself. For any request for an image, photo, ' +
  'illustration, painting, logo artwork, wallpaper or character, call generate_image with a ' +
  'detailed English prompt (subject, setting, lighting, colours, style). For flyers, posters, ' +
  'invitations, social media posts, stories and banners, call create_design and write all the ' +
  'real copy yourself: a short strong headline, a tagline and a call to action, plus the details ' +
  'the person actually gave you (date, time, venue, phone, price). Never invent names, dates, venues, ' +
  'prices, phone numbers, emails or websites; if something essential is missing, still call ' +
  'create_design and the app will ask the person for it before the design is made. Pick a theme and layout that suit the subject, and ' +
  'include image_prompt for almost every flyer, poster, social post, story and banner, because real photography is what makes a design look finished; leave it out only for quotes, notices, certificates and solemn pieces. Never write placeholders in square brackets or curly braces in any field: leave a field out when you do not have a real value for it. Image models cannot ' +
  'spell, so never ask a picture to contain words; put words in create_design. If the person ' +
  'gave exact wording, use it exactly. Do the work straight away instead of asking questions ' +
  'you can answer with sensible choices. After the result, reply in one or two plain ' +
  'sentences and offer one specific tweak (a different colour, layout or wording). Never ' +
  'paste image data or links, and never say you cannot make pictures.';

// Finished Word/PDF/PowerPoint/Excel files through create_document (doc-studio).
export const DOC_RULES =
  'You can make finished, professionally designed files with create_document: Word and PDF documents (reports, proposals, CVs, resumes, letters, memos, brochures, lesson plans), ' +
  'PowerPoint presentations (also as PDF) and Excel spreadsheets. Always use it for these requests; never answer with a .md or .txt file or paste the document into the chat. ' +
  'Write the complete, specific content yourself, with real figures and wording from the person, and no placeholders. ' +
  'For a document pass markdown (# Title, ## headings, paragraphs, lists, > quotes) or blocks when you want stat numbers, callouts or tables; use a few of those in reports and proposals instead of walls of text. ' +
  'For slides pass slides with varied layouts (title first, closing last, stat, quote, split, section between topics), 3 to 5 short bullets at most, and never several bullet slides in a row. ' +
  'Leave design out so the look matches the subject, or pick one when the person asks for a mood; do not choose the same design every time. ' +
  'A formal report, proposal or brochure gets a kicker, subtitle and a date or author only if the person gave them; letters, memos and CVs stay plain and short. ' +
  'When the person asks for a change or a new version, call create_document again with the full updated content and keep the same design unless they ask to change it. ' +
  'Flyers, posters, invitations and social graphics still use create_design. After the result reply in one or two plain sentences, name the file types, and offer one specific tweak. Never paste file data or links.';

// Structured components drawn by the interface (```cognita-ui).
export const UI_RULES =
  'Default to a plain written answer: greetings, casual chat, simple facts and ordinary explanations get no components. ' +
  'Use components only when structure clearly helps the person understand or act, and always write the answer in words first. ' +
  'Components are NOT tools: never call "cognita-ui" or a component name as a function. Write them as text in ONE fenced block after your words: ' +
  '```cognita-ui, then one JSON object {"id","type","props","children","actions"} (or an array of them), then ```. ' +
  'Put each component\'s content inside "props", never beside "type". Format example only (use the person\'s own content):\n' +
  '```cognita-ui\n[{"id":"spend","type":"bar_chart","props":{"title":"Monthly spend","labels":["Rent","Food"],"values":[500,300]}}]\n```\n' +
  'Use at most 6 top-level components (nest extras inside card, tabs or accordion); anything beyond 6 is dropped. Give each a short unique "id". ' +
  'Do not repeat in prose what a component already shows, and never write a heading or label for a component (its own title is drawn for you). Components appear in the chat by themselves: never tell the person to copy blocks anywhere or to use another menu to get the same layout. ' +
  'Keep the whole answer compact, with short descriptions and no more than about 8 rows or steps per component, so it always finishes. ' +
  'When the person asks to change something you already showed (a number, a row, a step), reply with one short sentence and patches against the component ids listed in the earlier answer, updating every component the change affects (for example the table, the chart and the total). Do not restate the whole answer. The sentence is plain text, never a heading and never a description of a patch. To add a step or item use {"op":"append","target":"<id>","items":[...]}; to change values use update; to change rows use append or replace. ' +
  'Never write tool-call syntax as text (no <|tool_call_start|>, no codegen(...) or function(...) calls): components go only in the cognita-ui fence. ' +
  'Choose by task: comparison = short summary + table; data analysis = data_summary with stat, chart and findings; study plan = plan + checklist or timeline; ' +
  'a process = steps; a sequence over time = timeline; several categories = tabs or accordion; collecting details = form; research = source_list + table or findings; ' +
  'code = code; a finished document = document_result; a finished picture or design = media_result.\n' +
  'Components (props, then what each is for):\n' + describeUi() + '\n' +
  '"actions" is optional. An AI action {label,prompt} sends that prompt back to you, so use it only for follow-ups that need your thinking (add withSelection:true on a table with selectable:true to include the picked rows). ' +
  'A local action {kind:"local",label,target:"<id>",state:{...}} only changes how a component looks (state keys: tabs{active}, accordion{open[]}, table{sort{col,dir},selected[]}, charts{view:"chart"|"table"}, checklist{checked[]}, card{open}). ' +
  'Tabs, accordions, sorting, row selection, checklists, step status, chart/table views, plan editing and form values already work in the browser without you. ' +
  'To change a component you already showed, send a patch in the same fence instead of repeating it: ' +
  '{"op":"append","target":"sales-table","rows":[[...]]} | {"op":"update","target":"study-plan","props":{...}} | {"op":"replace","target":"id","node":{...}} | {"op":"create","parent":"id","node":{...}} | {"op":"remove","target":"id"} | {"op":"set_state","target":"id","state":{...}}. Patch only ids you were given or created, at most 8 per answer. ' +
  'Never write HTML, CSS, JavaScript, event handlers or invented component names. Components only display information; they do nothing by themselves. ' +
  'Plans, budgets, timelines, launch steps, checklists, legal notes and sign-up forms are answered right here in the chat with these components, using no tools at all. Only call a tool when the person asks for what it does (run code on data, use a connected app, make a file, picture or design); then do the real work first and show what the tool actually returned. ' +
  'Use document_result or media_result only after the real tool produced the file or picture, and never claim a tool ran when it did not. ' +
  'Use real numbers from the person or from tool results. If you must estimate (a budget, a forecast), say so in your words and label it as an estimate; never present invented data as fact.';

// ── The router ─────────────────────────────────────────────────────────
// Fixed order = the order the texts are appended in prompts.js.
export const SKILL_NAMES = ['office-files', 'design-media', 'create-document', 'rich-components'];

// Over-inclusive on purpose (same idea as the connected-app router in connector-tools.js).
const OFFICE_RE = /\b(?:word|docx?|pdf|power ?point|pptx?|slides?|deck|presentations?|excel|xlsx?|csv|spreadsheets?|files?|downloads?|reports?|letters?|memos?|resumes?|cv|proposals?|brochures?|invoices?|certificates?|e-?books?|thesis|essays?|documents?|handouts?|lesson plans?|minutes|contracts?)\b/i;
const MEDIA_RE = /\b(?:images?|pictures?|photos?|illustrations?|logos?|flyers?|posters?|banners?|invitations?|designs?|designed|wallpapers?|graphics?|social (?:media )?posts?|stor(?:y|ies)|brochures?|certificates?|paintings?|draw(?:ing)?|artwork|characters?|covers?|thumbnails?|menus?|business cards?|mock-?ups?|icons?|generate|create (?:a|an|the))\b/i;
const DOCS_RE = /\b(?:word|docx?|pdf|power ?point|pptx?|slides?|deck|presentations?|excel|xlsx?|spreadsheets?|reports?|letters?|memos?|resumes?|cv|proposals?|brochures?|lesson plans?|documents?|contracts?|invoices?|essays?|ebooks?|e-books?)\b/i;
const RICH_RE = /\b(?:plans?|planner|budgets?|compar\w*|versus|vs|tables?|timelines?|checklists?|to-?do|schedules?|itinerar\w*|roadmaps?|step-by-step|steps|process|forms?|sign-?ups?|surveys?|questionnaires?|charts?|graphs?|pie|bar|dashboards?|data|analy[sz]\w*|statistics?|stats|summar\w*|pros and cons|research|sources?|rank\w*|top \d+|overview|breakdown|quiz|study|workouts?|meal|diet|lessons?|syllabus|forecast|estimates?|quotes?|templates?|framework|swot|okrs?|kpis?|outline|list|options|recommend\w*|show me|explain|diagram|flow|organi[sz]e|track\w*|calculat\w*|price|pricing|cost|launch|strategy|agenda|curriculum|recipes?|packing|goals?|habits?|resolutions?)\b/i;

function _anyMatches(re, texts) {
  for (const t of texts) if (re.test(t)) return true;
  return false;
}

/**
 * Decides which skills to load for this turn.
 * @param {object} opts
 * @param {string[]} opts.userTexts - the user's messages, newest first
 * @param {Array<{role:string,content:any}>} [opts.history] - recent messages (to spot an earlier component answer)
 * @returns {string[]|null} skill names in fixed order, or null = "load everything" when there is nothing to judge
 */
export function selectSkills({ userTexts = [], history = [] } = {}) {
  const texts = (Array.isArray(userTexts) ? userTexts : []).filter((t) => typeof t === 'string').slice(0, 3).map((t) => t.slice(0, 20000));
  if (texts.length === 0 || texts.every((t) => !t.trim())) return null; // fail open
  const recent = (Array.isArray(history) ? history : []).slice(-8);
  const usedComponents = recent.some((m) => m && m.role === 'assistant' && typeof m.content === 'string' && (m.content.includes('cognita-ui') || m.content.includes('[Components already shown on screen')));
  const picked = new Set();
  if (_anyMatches(OFFICE_RE, texts)) picked.add('office-files');
  if (_anyMatches(MEDIA_RE, texts)) picked.add('design-media');
  if (_anyMatches(DOCS_RE, texts)) picked.add('create-document');
  if (usedComponents || _anyMatches(RICH_RE, texts)) picked.add('rich-components');
  return SKILL_NAMES.filter((n) => picked.has(n));
}
