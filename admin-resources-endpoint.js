// admin-resources-endpoint.js
//
// Admin control center for Cognita ready-made resources.
//
// Lifecycle:
// GENERATE -> DRAFT -> EDIT -> VALIDATE -> PUBLISH
//
// Curated resources live separately from private user resources:
//
// readyMadeResources/<id>
// readyMadeResourceVersions/<id>_<version>
// adminGenerationJobs/<id>

import { requireAdmin } from './admin-middleware.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { fsGet, fsSet, fsUpdate, fsQuery } from './firestore-rest.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile } from './b2-client.js';
import { getRecipe } from './recipes/index.js';
import { resolveEntitledTemplate } from './design-templates.js';

const RESOURCE_MAX_TOKENS = 6000;
const PPTX_TYPES = new Set(['presentation']);

const RESOURCE_TYPES = [
  'lesson_plan',
  'worksheet',
  'exam',
  'scheme_of_work',
  'quiz',
  'study_guide',
  'teaching_guide',
  'classroom_activity',
  'assignment',
  'marking_scheme',
  'rubric',
  'flashcards',
  'student_handout',
  'presentation',
  'project',
  'test',
];

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function _error(message, status = 400) {
  return _json({ error: message }, status);
}

function _id(prefix = 'r') {
  return (
    prefix +
    '-' +
    Date.now().toString(36) +
    '-' +
    crypto.randomUUID().slice(0, 8)
  );
}

function _parseJson(text) {
  if (!text) return null;

  let clean = String(text)
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');

  if (start !== -1 && end !== -1) {
    clean = clean.slice(start, end + 1);
  }

  try {
    return JSON.parse(clean);
  } catch (_) {
    return null;
  }
}

function _sections(content) {
  const sections = [];

  for (const key of Object.keys(content || {})) {
    if (key === 'title') continue;

    const value = content[key];

    if (value === null || typeof value === 'undefined') continue;

    const heading = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase());

    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item && typeof item === 'object') {
          return Object.values(item)
            .filter(
              (v) =>
                typeof v === 'string' ||
                typeof v === 'number'
            )
            .join(' — ');
        }

        return String(item);
      });

      if (items.length) {
        sections.push({
          heading,
          type: 'bullets',
          content: items,
        });
      }
    } else if (typeof value === 'object') {
      sections.push({
        heading,
        type: 'paragraph',
        content: JSON.stringify(value),
      });
    } else if (String(value).trim()) {
      sections.push({
        heading,
        type: 'paragraph',
        content: String(value),
      });
    }
  }

  return sections;
}

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function _buildExports(resource, env) {
  const refs = {};
  const content = resource.structuredContent;
  const title = content?.title || resource.title;

  if (
    PPTX_TYPES.has(resource.resourceType) &&
    Array.isArray(content?.slides)
  ) {
    try {
      const pptx = await buildSimplePptx(
        content.slides,
        title,
        resource.designTemplateId
      );

      const key =
        `curated/${resource.id}/v${resource.currentVersion}/` +
        `${resource.resourceType}.pptx`;

      const upload = await b2UploadFile(
        env,
        key,
        _base64ToBytes(pptx),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );

      refs.pptx = {
        key,
        fileId: upload.fileId,
      };
    } catch (e) {
      console.error('[admin] PPTX export failed:', e.message);
    }

    try {
      const sections = content.slides.map((slide) => ({
        heading: slide.heading || '',
        type: 'bullets',
        content: Array.isArray(slide.bulletPoints)
          ? slide.bulletPoints
          : [String(slide.bulletPoints || '')],
      }));

      const pdf = await buildStructuredPdf(
        { title, sections },
        title,
        resource.designTemplateId
      );

      const key =
        `curated/${resource.id}/v${resource.currentVersion}/` +
        `${resource.resourceType}.pdf`;

      const upload = await b2UploadFile(
        env,
        key,
        _base64ToBytes(pdf),
        'application/pdf'
      );

      refs.pdf = {
        key,
        fileId: upload.fileId,
      };
    } catch (e) {
      console.error('[admin] PDF export failed:', e.message);
    }

    return refs;
  }

  const sections = _sections(content);

  try {
    const pdf = await buildStructuredPdf(
      { title, sections },
      title,
      resource.designTemplateId
    );

    const key =
      `curated/${resource.id}/v${resource.currentVersion}/` +
      `${resource.resourceType}.pdf`;

    const upload = await b2UploadFile(
      env,
      key,
      _base64ToBytes(pdf),
      'application/pdf'
    );

    refs.pdf = {
      key,
      fileId: upload.fileId,
    };
  } catch (e) {
    console.error('[admin] PDF export failed:', e.message);
  }

  try {
    const docx = await buildStructuredDocx(
      { title, sections },
      title,
      resource.designTemplateId
    );

    const key =
      `curated/${resource.id}/v${resource.currentVersion}/` +
      `${resource.resourceType}.docx`;

    const upload = await b2UploadFile(
      env,
      key,
      _base64ToBytes(docx),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    refs.docx = {
      key,
      fileId: upload.fileId,
    };
  } catch (e) {
    console.error('[admin] DOCX export failed:', e.message);
  }

  return refs;
}

function _validateFields(recipe, fields) {
  for (const required of recipe.requiredFields || []) {
    if (
      !fields[required] ||
      !String(fields[required]).trim()
    ) {
      return {
        ok: false,
        error: `Missing required field: ${required}`,
      };
    }
  }

  return { ok: true };
}

async function _generateOne({
  resourceType,
  fields,
  designTemplateId,
  createdBy,
  env,
}) {
  const recipe = getRecipe(resourceType);

  if (!recipe) {
    throw new Error(`Unknown resource type: ${resourceType}`);
  }

  const required = _validateFields(recipe, fields);

  if (!required.ok) {
    throw new Error(required.error);
  }

  const templateResolution = resolveEntitledTemplate(
    'pro',
    designTemplateId,
    () => true
  );

  const resolvedTemplate =
    templateResolution.ok && templateResolution.template
      ? templateResolution.template
      : { id: designTemplateId || 'default' };

  const id = _id('curated');
  const now = new Date().toISOString();

  const base = {
    id,
    resourceType,
    title: fields.topic || 'Untitled Resource',
    description: '',
    subject: fields.subject || '',
    educationalLevel: fields.educationalLevel || '',
    classLevel: fields.classLevel || '',
    curriculum: fields.curriculum || '',
    topic: fields.topic || '',
    tags: [],
    status: 'draft',
    featured: false,
    recommended: false,
    sortOrder: 0,
    source: 'curated',
    currentVersion: 1,
    structuredContent: null,
    designTemplateId: resolvedTemplate.id,
    createdBy,
    updatedBy: createdBy,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    fileReferences: {},
  };

  await fsSet(
    `readyMadeResources/${id}`,
    base,
    env
  );

  const messages = [
    {
      role: 'system',
      content: recipe.systemPrompt,
    },
    {
      role: 'user',
      content:
        recipe.buildUserPrompt(fields) +
        `\n\nThis is a Cognita curated resource. ` +
        `Create exceptionally clear, classroom-ready content. ` +
        `Return JSON only.`,
    },
  ];

  const result = await callWithFallback(
    MODEL_TIERS.advanced,
    messages,
    env,
    {
      maxTokens: RESOURCE_MAX_TOKENS,
      jsonMode: true,
    }
  );

  const structuredContent = _parseJson(result.text);

  if (!structuredContent) {
    throw new Error('AI returned invalid structured content.');
  }

  const validation = recipe.validate(
    structuredContent,
    fields
  );

  if (!validation.ok) {
    throw new Error(
      validation.error ||
      'Generated resource failed validation.'
    );
  }

  const finalResource = {
    ...base,
    title:
      structuredContent.title ||
      base.title,
    structuredContent,
    updatedAt: new Date().toISOString(),
  };

  await fsSet(
    `readyMadeResources/${id}`,
    finalResource,
    env
  );

  await fsSet(
    `readyMadeResourceVersions/${id}_1`,
    {
      resourceId: id,
      version: 1,
      structuredContent,
      designTemplateId: resolvedTemplate.id,
      createdBy,
      createdAt: finalResource.updatedAt,
    },
    env
  );

  return finalResource;
}

/* ─────────────────────────────────────────────
   GET /api/admin/resources
───────────────────────────────────────────── */

export async function handleAdminResourceList(
  request,
  env
) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _error(
      e.message,
      e.status || 401
    );
  }

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let resources = [];

    if (status) {
      resources = await fsQuery(
        'readyMadeResources',
        'status',
        status,
        'updatedAt',
        100,
        env
      );
    } else {
      resources = await fsQuery(
        'readyMadeResources',
        'source',
        'curated',
        'updatedAt',
        100,
        env
      );
    }

    return _json({
      resources: Array.isArray(resources)
        ? resources
        : [],
    });
  } catch (e) {
    console.error('[admin] list failed:', e.message);
    return _error(
      'Could not load resources.',
      500
    );
  }
}

/* ─────────────────────────────────────────────
   GET /api/admin/resources/:id
───────────────────────────────────────────── */

export async function handleAdminResourceGet(
  request,
  env,
  resourceId
) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  const resource = await fsGet(
    `readyMadeResources/${resourceId}`,
    env
  );

  if (!resource) {
    return _error('Resource not found.', 404);
  }

  return _json({ resource });
}

/* ─────────────────────────────────────────────
   POST /api/admin/resources/generate
───────────────────────────────────────────── */

export async function handleAdminResourceGenerate(
  request,
  env
) {
  let identity;

  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return _error('Invalid JSON body.');
  }

  const {
    resourceType,
    fields = {},
    designTemplateId,
    count = 1,
  } = body;

  if (!RESOURCE_TYPES.includes(resourceType)) {
    return _error('Invalid resource type.');
  }

  const amount = Math.min(
    Math.max(Number(count) || 1, 1),
    20
  );

  // A batch becomes a Firestore job rather than one giant HTTP request.
  if (amount > 1) {
    const jobId = _id('job');

    const items = Array.from(
      { length: amount },
      (_, index) => ({
        index,
        status: 'queued',
        resourceId: null,
        error: null,
      })
    );

    const job = {
      id: jobId,
      status: 'queued',
      createdBy: identity.uid,
      resourceType,
      fields,
      designTemplateId:
        designTemplateId || 'default',
      items,
      total: amount,
      completed: 0,
      failed: 0,
      currentIndex: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fsSet(
      `adminGenerationJobs/${jobId}`,
      job,
      env
    );

    return _json({
      job,
      message: `Batch generation job created for ${amount} resources.`,
    });
  }

  try {
    const resource = await _generateOne({
      resourceType,
      fields,
      designTemplateId,
      createdBy: identity.uid,
      env,
    });

    return _json({ resource });
  } catch (e) {
    console.error('[admin] generation failed:', e.message);
    return _error(
      e.message || 'Generation failed.',
      503
    );
  }
}

/* ─────────────────────────────────────────────
   POST /api/admin/generation-jobs/:id/process
───────────────────────────────────────────── */

export async function handleAdminJobProcess(
  request,
  env,
  jobId
) {
  let identity;

  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  const job = await fsGet(
    `adminGenerationJobs/${jobId}`,
    env
  );

  if (!job) {
    return _error('Generation job not found.', 404);
  }

  if (
    job.createdBy !== identity.uid &&
    !String(env.COGNITA_ADMIN_UIDS || '')
      .split(',')
      .includes(identity.uid)
  ) {
    return _error('Not allowed.', 403);
  }

  if (job.status === 'completed') {
    return _json({ job });
  }

  const index = job.currentIndex;

  if (index >= job.total) {
    const completedJob = {
      ...job,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };

    await fsSet(
      `adminGenerationJobs/${jobId}`,
      completedJob,
      env
    );

    return _json({ job: completedJob });
  }

  const item = job.items[index];

  item.status = 'running';

  await fsSet(
    `adminGenerationJobs/${jobId}`,
    {
      ...job,
      status: 'running',
      items: job.items,
      updatedAt: new Date().toISOString(),
    },
    env
  );

  try {
    const resource = await _generateOne({
      resourceType: job.resourceType,
      fields: job.fields,
      designTemplateId: job.designTemplateId,
      createdBy: identity.uid,
      env,
    });

    item.status = 'completed';
    item.resourceId = resource.id;

    const completed = (job.completed || 0) + 1;
    const currentIndex = index + 1;

    const nextJob = {
      ...job,
      status:
        currentIndex >= job.total
          ? 'completed'
          : 'running',
      items: job.items,
      completed,
      currentIndex,
      updatedAt: new Date().toISOString(),
    };

    await fsSet(
      `adminGenerationJobs/${jobId}`,
      nextJob,
      env
    );

    return _json({
      job: nextJob,
      resource,
    });
  } catch (e) {
    item.status = 'failed';
    item.error = e.message;

    const nextJob = {
      ...job,
      status:
        index + 1 >= job.total
          ? 'completed'
          : 'running',
      items: job.items,
      failed: (job.failed || 0) + 1,
      currentIndex: index + 1,
      updatedAt: new Date().toISOString(),
    };

    await fsSet(
      `adminGenerationJobs/${jobId}`,
      nextJob,
      env
    );

    return _json({
      job: nextJob,
      error: e.message,
    }, 200);
  }
}

/* ─────────────────────────────────────────────
   GET /api/admin/generation-jobs
───────────────────────────────────────────── */

export async function handleAdminJobList(
  request,
  env
) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  try {
    const jobs = await fsQuery(
      'adminGenerationJobs',
      'createdBy',
      (
        await requireAdmin(request, env)
      ).uid,
      'createdAt',
      50,
      env
    );

    return _json({
      jobs: Array.isArray(jobs) ? jobs : [],
    });
  } catch (e) {
    return _error(
      'Could not load generation jobs.',
      500
    );
  }
}

/* ─────────────────────────────────────────────
   PATCH /api/admin/resources/:id
───────────────────────────────────────────── */

export async function handleAdminResourceUpdate(
  request,
  env,
  resourceId
) {
  let identity;

  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  const existing = await fsGet(
    `readyMadeResources/${resourceId}`,
    env
  );

  if (!existing) {
    return _error('Resource not found.', 404);
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return _error('Invalid JSON body.');
  }

  const allowed = [
    'title',
    'description',
    'subject',
    'educationalLevel',
    'classLevel',
    'curriculum',
    'topic',
    'tags',
    'featured',
    'recommended',
    'sortOrder',
    'structuredContent',
    'designTemplateId',
  ];

  const patch = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }

  patch.updatedBy = identity.uid;
  patch.updatedAt = new Date().toISOString();

  const updated = {
    ...existing,
    ...patch,
  };

  if (
    body.structuredContent &&
    JSON.stringify(body.structuredContent) !==
      JSON.stringify(existing.structuredContent)
  ) {
    updated.currentVersion =
      Number(existing.currentVersion || 1) + 1;

    await fsSet(
      `readyMadeResourceVersions/${resourceId}_${updated.currentVersion}`,
      {
        resourceId,
        version: updated.currentVersion,
        structuredContent:
          body.structuredContent,
        designTemplateId:
          body.designTemplateId ||
          existing.designTemplateId,
        createdBy: identity.uid,
        createdAt: updated.updatedAt,
      },
      env
    );
  }

  await fsSet(
    `readyMadeResources/${resourceId}`,
    updated,
    env
  );

  return _json({ resource: updated });
}

/* ─────────────────────────────────────────────
   POST /api/admin/resources/:id/publish
───────────────────────────────────────────── */

export async function handleAdminResourcePublish(
  request,
  env,
  resourceId
) {
  let identity;

  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  const resource = await fsGet(
    `readyMadeResources/${resourceId}`,
    env
  );

  if (!resource) {
    return _error('Resource not found.', 404);
  }

  if (!resource.structuredContent) {
    return _error(
      'Resource has no generated content.',
      400
    );
  }

  const recipe = getRecipe(resource.resourceType);

  if (!recipe) {
    return _error('Unknown resource type.', 400);
  }

  const validation = recipe.validate(
    resource.structuredContent,
    {
      subject: resource.subject,
      educationalLevel:
        resource.educationalLevel,
      classLevel: resource.classLevel,
      curriculum: resource.curriculum,
      topic: resource.topic,
    }
  );

  if (!validation.ok) {
    return _error(
      validation.error ||
        'Resource failed validation.',
      400
    );
  }

  const fileReferences = await _buildExports(
    resource,
    env
  );

  const now = new Date().toISOString();

  const published = {
    ...resource,
    status: 'published',
    visibility: 'public',
    fileReferences,
    publishedAt:
      resource.publishedAt || now,
    updatedBy: identity.uid,
    updatedAt: now,
  };

  await fsSet(
    `readyMadeResources/${resourceId}`,
    published,
    env
  );

  return _json({
    resource: published,
  });
}

/* ─────────────────────────────────────────────
   POST /api/admin/resources/:id/archive
───────────────────────────────────────────── */

export async function handleAdminResourceArchive(
  request,
  env,
  resourceId
) {
  let identity;

  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _error(e.message, e.status || 401);
  }

  const resource = await fsGet(
    `readyMadeResources/${resourceId}`,
    env
  );

  if (!resource) {
    return _error('Resource not found.', 404);
  }

  const archived = {
    ...resource,
    status: 'archived',
    updatedBy: identity.uid,
    updatedAt: new Date().toISOString(),
  };

  await fsSet(
    `readyMadeResources/${resourceId}`,
    archived,
    env
  );

  return _json({ resource: archived });
}
