import { normalizeVirtualPath } from '../utils/fileNames.js';

const INTERACTIONS_BASE = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Context7 official agent-loop examples use turn_limit 5-15; 3 starved multi-step
// tasks (search -> search -> act) leaving no turn for the final text answer.
const MAX_ITERATIONS = 8;
const MAX_CONTENT_LEN = 4000;
const SMART_FUZZY_LIMIT = 6;

export const AI_SYSTEM_PROMPT = `Eres el asistente de IA de OmniCloud, un filesystem virtual unificado que reúne archivos de todos los servicios de almacenamiento conectados del usuario (Google Drive, Dropbox, OneDrive, S3, Mega, Yandex). Para ti no existen servicios individuales: solo carpetas y archivos dentro de una única ruta virtual como /Musica/2026/cancion.mp3.

Reglas:
1. Responde siempre en el idioma del usuario (por defecto, español). Usa un tono natural y claro.
2. Para ver u organizar archivos usa SIEMPRE las herramientas disponibles, nunca inventes rutas ni archivos.
3. Para CREAR carpetas y ORGANIZAR archivos (mover a carpetas lógicas por tipo/fecha): hazlo AUTÓNOMAMENTE, inventa nombres descriptivos (ej. /Imagenes, /Documentos, /Videos, /Minecraft, /Proyectos) y ejecuta sin pedir confirmación.
4. NUNCA borres archivos sin confirmación explícita del usuario. Antes de borrar algo, pregunta y espera un "sí" inequívoco.
5. Para mover archivos entre carpetas existentes: hazlo autónomamente si es organización lógica (ej. mover fotos a /Imagenes). Si el usuario pide mover a una ruta específica, ejecútalo.
6. Si una operación falla, explica el error de forma comprensible y sugiere alternativas.
7. Sé conciso: 2-4 frases por respuesta salvo que el usuario pida más detalle.
8. NUNCA inventes rutas: usa SIEMPRE las rutas exactas que devuelven las herramientas. Si el usuario nombra algo de forma imprecisa (ej. "la carpeta de fotos", "el documento de Carlos"), localízalo primero con search_files o list_files y usa la ruta real devuelta.
9. Cuando una herramienta devuelva "candidates", elige el más relevante según el contexto del usuario y procede con su ruta completa; si la carpeta destino de un movimiento no existe y la intención es organizar, créala primero con create_folder y repite el movimiento.
10. En cuanto completes lo pedido, responde con tu texto final SIN llamar más herramientas.`;

export const AI_TOOL_DEFS = [
  { name: 'list_files', description: 'Lista los archivos y carpetas de una ruta virtual (por defecto la raíz "/").', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta virtual, p.ej. "/Musica" o "/" (raíz).' } }, required: ['path'] } },
  { name: 'search_files', description: 'Busca archivos y carpetas por nombre en todo el espacio de almacenamiento.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Texto a buscar en los nombres.' } }, required: ['query'] } },
  { name: 'recent_files', description: 'Lista los archivos más recientes del usuario (por fecha de modificación, descendente) en todo el espacio de almacenamiento.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Número máximo de archivos a devolver (por defecto 20).' } } } },
  { name: 'get_storage_summary', description: 'Resumen del espacio de almacenamiento: cuentas conectadas, espacio usado/disponible y recuento de archivos.', parameters: { type: 'object', properties: {} } },
  { name: 'create_folder', description: 'Crea una carpeta nueva en la ruta virtual indicada (crea también las carpetas intermedias si hacen falta).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta completa de la carpeta nueva, p.ej. "/Musica/2026".' } }, required: ['path'] } },
  { name: 'move_item', description: 'Mueve un archivo o carpeta a una carpeta destino. OmniCloud localiza el elemento aunque el nombre sea aproximado y lo mueve entre servicios automáticamente. La carpeta destino debe existir (usa "/" para la raíz) o créala antes con create_folder.', parameters: { type: 'object', properties: { source_path: { type: 'string', description: 'Ruta actual del archivo/carpeta, p.ej. "/Descargas/video.mp4".' }, destination_path: { type: 'string', description: 'Ruta de la carpeta destino, p.ej. "/Videos" (no incluye el nombre del archivo).' } }, required: ['source_path', 'destination_path'] } },
  { name: 'rename_item', description: 'Renombra un archivo o carpeta.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta actual, p.ej. "/Documentos/borrador.txt".' }, new_name: { type: 'string', description: 'Nuevo nombre, p.ej. "final.txt".' } }, required: ['path', 'new_name'] } },
  { name: 'delete_item', description: 'Borra definitivamente un archivo o carpeta. IMPORTANTE: solo llama a esta herramienta después de que el usuario haya confirmado explícitamente que quiere borrar.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta del archivo o carpeta a borrar.' } }, required: ['path'] } },
];

function parentPathOf(path) {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '/';
  const parts = trimmed.split('/');
  parts.pop();
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function lastSegmentOf(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

// Smart resolution for AI tools: exact path match first, then a
// case-insensitive fallback on the last segment across virtual folders and/or
// physical metadata rows. Users name things loosely ("la carpeta de fotos")
// and models drop path prefixes; literal matching made moves fail or,
// worse, silently land at root.
//   -> { found:true, root?:true, type:'vf'|'fm', id, path }
//   -> { found:false, reason:'not_found'|'ambiguous', candidates:[{label,type}] }
async function resolveItemSmart(db, userId, rawPath, { kind = 'any' } = {}) {
  const norm = normalizeVirtualPath(rawPath);
  const bare = norm.replace(/\/+$/, '') || '/';

  if (bare === '/') return kind === 'folder' ? { found: true, root: true, id: null, path: '/' } : { found: false, reason: 'not_found', candidates: [] };

  if (kind !== 'file') {
    const vf = await db`SELECT id FROM virtual_folders WHERE user_id=${userId} AND path=${norm} LIMIT 1`;
    if (vf[0]) return { found: true, type: 'vf', id: vf[0].id, path: norm };
  }
  if (kind !== 'folder') {
    const fm = await db`SELECT id FROM file_metadata WHERE user_id=${userId} AND virtual_path || file_name = ${bare} LIMIT 1`;
    if (fm[0]) return { found: true, type: 'fm', id: fm[0].id, path: bare };
  }

  const name = lastSegmentOf(bare);
  if (!name) return { found: false, reason: 'not_found', candidates: [] };

  const pattern = `%${name.replace(/\\/g, '\\\\').replace(/([%_])/g, '\\$1')}%`;
  const candidates = [];
  if (kind !== 'file') {
    const vfs = await db`SELECT parent_path, name FROM virtual_folders WHERE user_id=${userId} AND name ILIKE ${pattern} ORDER BY char_length(name), name LIMIT ${SMART_FUZZY_LIMIT}`;
    for (const v of vfs) candidates.push({ label: `${v.parent_path}${v.name}`, type: 'folder' });
  }
  if (kind === 'folder') {
    const fms = await db`SELECT file_name, virtual_path FROM file_metadata WHERE user_id=${userId} AND is_folder=TRUE AND file_name ILIKE ${pattern} ORDER BY char_length(file_name), file_name LIMIT ${SMART_FUZZY_LIMIT}`;
    for (const f of fms) candidates.push({ label: `${f.virtual_path}${f.file_name}`, type: 'folder' });
  } else {
    const fms = await db`SELECT file_name, virtual_path, is_folder FROM file_metadata WHERE user_id=${userId} AND file_name ILIKE ${pattern} ORDER BY char_length(file_name), file_name LIMIT ${SMART_FUZZY_LIMIT}`;
    for (const f of fms) candidates.push({ label: `${f.virtual_path}${f.file_name}`, type: f.is_folder ? 'folder' : 'file' });
  }
  const unique = [...new Map(candidates.map((c) => [c.label.toLowerCase(), c])).values()].slice(0, SMART_FUZZY_LIMIT);
  if (unique.length === 1) return resolveItemSmart(db, userId, unique[0].label, { kind });
  if (unique.length > 1) return { found: false, reason: 'ambiguous', candidates: unique };
  return { found: false, reason: 'not_found', candidates: [] };
}

function compactRow(row) {
  return { name: row.file_name, is_folder: Boolean(row.is_folder), size: Number(row.size || 0), mime_type: row.mime_type || null, modified: row.remote_modified_time || row.updated_at || null };
}

async function executeTool({ env, user, db, internalFetch }, name, args) {
  switch (name) {
    case 'list_files': {
      const path = normalizeVirtualPath(args.path || '/');
      const rows = await db`SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified FROM file_metadata fm JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id WHERE fm.user_id = ${user.id} AND fm.virtual_path = ${path} AND ca.status = 'active' ORDER BY fm.is_folder DESC, fm.file_name ASC LIMIT 100`;
      const vfs = await db`SELECT name FROM virtual_folders WHERE user_id = ${user.id} AND parent_path = ${path}`;
      const items = rows.map(compactRow);
      const existing = new Set(rows.map((r) => r.file_name));
      for (const vf of vfs) { if (!existing.has(vf.name)) items.push({ name: vf.name, is_folder: true, size: 0, mime_type: null, modified: null }); }
      return { path, count: items.length, items: items.slice(0, 100) };
    }
    case 'search_files': {
      const query = String(args.query || '').trim().slice(0, 100);
      if (!query) {
        const recent = await db`SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified, fm.virtual_path FROM file_metadata fm JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id WHERE fm.user_id = ${user.id} AND ca.status = 'active' AND fm.is_folder = FALSE ORDER BY COALESCE(fm.remote_modified_time, fm.created_at) DESC, fm.file_name ASC LIMIT 20`;
        return { query: null, note: 'No se proporcionó un texto de búsqueda; se devolvieron los archivos más recientes.', count: recent.length, items: recent.map((row) => ({ path: `${row.virtual_path}${row.file_name}`, ...compactRow(row) })) };
      }
      const rows = await db`SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified, fm.virtual_path FROM file_metadata fm JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id WHERE fm.user_id = ${user.id} AND ca.status = 'active' AND fm.file_name ILIKE ${`%${query}%`} ORDER BY fm.is_folder DESC, COALESCE(fm.remote_modified_time, fm.created_at) DESC, fm.file_name ASC LIMIT 30`;
      return { query, count: rows.length, items: rows.map((row) => ({ path: `${row.virtual_path}${row.file_name}`, ...compactRow(row) })) };
    }
    case 'recent_files': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const rows = await db`SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified, fm.virtual_path FROM file_metadata fm JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id WHERE fm.user_id = ${user.id} AND ca.status = 'active' AND fm.is_folder = FALSE ORDER BY COALESCE(fm.remote_modified_time, fm.created_at) DESC, fm.file_name ASC LIMIT ${limit}`;
      return { count: rows.length, items: rows.map((row) => ({ path: `${row.virtual_path}${row.file_name}`, ...compactRow(row) })) };
    }
    case 'get_storage_summary': {
      const accounts = await db`SELECT provider, email, status, total_space, used_space FROM cloud_accounts WHERE user_id = ${user.id} ORDER BY provider, email`;
      const stats = await db`SELECT ca.provider, COUNT(*) FILTER (WHERE fm.is_folder = FALSE) AS files, COALESCE(SUM(fm.size) FILTER (WHERE fm.is_folder = FALSE), 0)::bigint AS bytes FROM file_metadata fm JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id WHERE fm.user_id = ${user.id} AND ca.status = 'active' GROUP BY ca.provider ORDER BY ca.provider`;
      return { accounts: accounts.map((a) => ({ provider: a.provider, email: a.email, status: a.status, total_space: Number(a.total_space || 0), used_space: Number(a.used_space || 0) })), stats: stats.map((s) => ({ provider: s.provider, files: Number(s.files || 0), bytes: Number(s.bytes || 0) })) };
    }
    case 'create_folder': {
      const fullPath = normalizeVirtualPath(args.path || '');
      const name = fullPath.replace(/^\/+|\/+$/g, '').split('/').pop();
      if (!name) return { error: 'Ruta de carpeta no válida' };
      const parent = parentPathOf(fullPath);
      const { status, body } = await internalFetch('/api/files/folders', { method: 'POST', body: { name, virtual_path: parent } });
      if (status >= 400) return { error: body?.error || 'No se pudo crear la carpeta' };
      return { success: true, path: fullPath };
    }
    case 'move_item': {
      const src = await resolveItemSmart(db, user.id, args.source_path);
      if (!src.found) {
        if (src.reason === 'ambiguous') return { error: `"${args.source_path}" coincide con varios elementos`, candidates: src.candidates, hint: 'Repite el movimiento con la ruta completa exacta del elemento correcto.' };
        return { error: `No se encontró el archivo o carpeta "${args.source_path}". Prueba a localizarlo con search_files.` };
      }
      if (src.root) return { error: 'El origen no puede ser la raíz' };
      let destToSend;
      const destNorm = normalizeVirtualPath(args.destination_path || '/');
      if (destNorm === '/') destToSend = '/';
      else {
        const dst = await resolveItemSmart(db, user.id, args.destination_path, { kind: 'folder' });
        if (!dst.found) {
          if (dst.reason === 'ambiguous') return { error: `La carpeta destino "${args.destination_path}" es ambigua`, candidates: dst.candidates, hint: 'Indica la carpeta destino con su ruta completa o créala con create_folder.' };
          return { error: `La carpeta destino "${args.destination_path}" no existe. Créala primero con create_folder(path="${destNorm}") y repite el movimiento.` };
        }
        destToSend = dst.root ? '/' : normalizeVirtualPath(dst.path);
      }
      // Physical sources: the move endpoint resolves destinations only within
      // the source's account and silently falls back to root otherwise —
      // pre-validate here and pass destination_folder_id for an exact match.
      if (src.type === 'fm' && destToSend !== '/') {
        const segs = destToSend.replace(/\/+$/, '').split('/').filter(Boolean);
        const folderName = segs.pop();
        const parentPath = segs.length ? `/${segs.join('/')}/` : '/';
        let destinationIdToSend = null;
        const sameAccountDest = folderName ? (await db`SELECT id FROM file_metadata WHERE user_id=${user.id} AND cloud_account_id=(SELECT cloud_account_id FROM file_metadata WHERE id=${src.id}) AND is_folder=TRUE AND virtual_path=${parentPath} AND file_name=${folderName} LIMIT 1`)[0] : null;
        if (sameAccountDest) {
          destinationIdToSend = sameAccountDest.id;
        } else {
          // Dual-read fallback: after P1 migration folders live only in virtual_folders.
          const vfMatch = folderName ? (await db`SELECT id FROM virtual_folders WHERE user_id=${user.id} AND parent_path=${parentPath} AND name=${folderName} LIMIT 1`)[0] : null;
          if (vfMatch) {
            const vfmSameAccount = (await db`SELECT vfm.cloud_account_id FROM virtual_folder_materializations vfm WHERE vfm.virtual_folder_id=${vfMatch.id} AND vfm.user_id=${user.id} AND vfm.status='active' AND vfm.cloud_account_id=(SELECT cloud_account_id FROM file_metadata WHERE id=${src.id}) LIMIT 1`)[0];
            if (vfmSameAccount) destinationIdToSend = vfMatch.id;
          }
        }
        if (!destinationIdToSend) return { error: `La carpeta "${destToSend}" no está disponible en la cuenta donde vive ese archivo. Créala ahí con create_folder e inténtalo de nuevo.` };
        const { status, body } = await internalFetch(`/api/files/${src.id}/move`, { method: 'POST', body: { destination_folder_id: destinationIdToSend } });
        if (status >= 400) return { error: body?.error || 'No se pudo mover' };
      } else {
        const { status, body } = await internalFetch(`/api/files/${src.id}/move`, { method: 'POST', body: { virtual_path: destToSend } });
        if (status >= 400) return { error: body?.error || 'No se pudo mover' };
      }
      const movedName = src.path.split('/').filter(Boolean).pop();
      return { success: true, moved_to: `${destToSend === '/' ? '/' : destToSend}${movedName}` };
    }
    case 'rename_item': {
      const item = await resolveItemSmart(db, user.id, args.path);
      if (!item.found) {
        if (item.reason === 'ambiguous') return { error: `"${args.path}" coincide con varios elementos`, candidates: item.candidates, hint: 'Indica la ruta completa exacta del elemento a renombrar.' };
        return { error: `No se encontró el archivo o carpeta "${args.path}".` };
      }
      const newName = String(args.new_name || '').trim();
      if (!newName) return { error: 'El nombre nuevo no puede estar vacío' };
      const { status, body } = await internalFetch(`/api/files/${item.id}/rename`, { method: 'PATCH', body: { name: newName } });
      if (status >= 400) return { error: body?.error || 'No se pudo renombrar' };
      return { success: true };
    }
    case 'delete_item': {
      const item = await resolveItemSmart(db, user.id, args.path);
      if (!item.found) {
        if (item.reason === 'ambiguous') return { error: `"${args.path}" coincide con varios elementos`, candidates: item.candidates, hint: 'Indica la ruta completa exacta del elemento a borrar.' };
        return { error: `No se encontró el archivo o carpeta "${args.path}".` };
      }
      const { status, body } = await internalFetch(`/api/files/${item.id}`, { method: 'DELETE' });
      if (status >= 400) return { error: body?.error || 'No se pudo borrar' };
      return { success: true };
    }
    default: return { error: `Herramienta desconocida: ${name}` };
  }
}

async function interactionsTurn({ env, model, input, tools, onEvent, interactionId, environmentId }) {
  // Unary call (no alt=sse): Context7 documents COMPLETE step.arguments in
  // non-streaming responses; streaming lite models never delivered argument deltas.
  const body = {
    model,
    input,
    tools,
  };
  if (interactionId) body.previous_interaction_id = interactionId;
  if (environmentId) body.environment = environmentId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let response;
  try {
    response = await fetch(INTERACTIONS_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = '';
    try { const payload = await response.json(); detail = payload?.error?.message || JSON.stringify(payload).slice(0, 500); } catch {}
    const error = new Error(`Error del proveedor de IA (${response.status}): ${detail || 'respuesta vacía'}`);
    error.code = response.status === 400 ? 'AI_BAD_REQUEST' : 'AI_PROVIDER_ERROR';
    throw error;
  }

  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Respuesta inválida del proveedor de IA'), { code: 'AI_PROVIDER_ERROR' }); }

  // Tolerant shape: interaction may be top-level or nested under data.interaction
  const interaction = data.interaction || data;
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];

  let text = '';
  const functionCalls = [];
  for (const step of steps) {
    if (step.type === 'thought' && Array.isArray(step.summary)) {
      for (const block of step.summary) { if (block?.type === 'text' && block.text) onEvent({ type: 'thought', delta: block.text }); }
    } else if (step.type === 'function_call') {
      // Context7: arguments arrive complete here (dict or JSON string)
      let args = step.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      onEvent({ type: 'tool', name: step.name, status: 'running' });
      functionCalls.push({ name: step.name, args, callId: step.id });
    } else if (step.type === 'model_output') {
      const blocks = step.content || step.parts || [];
      for (const block of blocks) {
        const chunk = typeof block === 'string' ? block : (block?.text || '');
        if (chunk) { text += chunk; onEvent({ type: 'text', delta: chunk }); }
      }
    }
  }

  if (!text) {
    const outputText = interaction.output_text ?? data.output_text;
    if (typeof outputText === 'string' && outputText) { text = outputText; onEvent({ type: 'text', delta: outputText }); }
  }

  console.error('[ai-dbg] turn', JSON.stringify({
    status: interaction.status || data.status,
    stepTypes: steps.map((s) => s.type),
    calls: functionCalls.map((c) => ({ name: c.name, args: c.args })),
    textLen: text.length,
  }).slice(0, 900));

  return {
    text,
    functionCalls,
    usage: data.usage || data.usage_metadata || interaction.usage || null,
    interactionId: data.interaction?.id || data.id || interaction.id || null,
    environmentId: data.environment_id || interaction.environment_id || null,
  };
}

export async function runAgent({ env, contents, onEvent, executeTool: toolExecutor }) {
  const model = env.AI_MODEL || 'gemini-3.5-flash-lite';
  let iterations = 0;
  let usage = null;
  let interactionId = null;
  let environmentId = null;

  // Build the initial user prompt from chat history
  const lastUserMsg = [...contents].reverse().find(c => c.role === 'user');
  const lastParts = lastUserMsg?.parts || (lastUserMsg?.content ? [{ text: String(lastUserMsg.content) }] : []);
  const userPrompt = lastParts.map(p => p.text).join('\n');

  // First turn: input is system prompt + user message (concatenated)
  let input = `${AI_SYSTEM_PROMPT}\n\n${userPrompt}`;

  const tools = AI_TOOL_DEFS.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const turn = await interactionsTurn({
      env, model, input, tools, onEvent,
      interactionId, environmentId,
    });
    if (turn.usage) usage = turn.usage;
    interactionId = turn.interactionId;
    environmentId = turn.environmentId;

    if (turn.functionCalls.length === 0) {
      return { text: turn.text, toolCount: iterations - 1, usage };
    }

    // Execute tools and build function_result array
    const functionResults = [];
    for (const call of turn.functionCalls) {
      onEvent({ type: 'tool', name: call.name, status: 'running' });
      let result;
      try { result = { ok: true, ...(await toolExecutor(call.name, call.args)) }; } catch (error) { result = { ok: false, error: error.message || 'Error de herramienta', code: error.code || 'TOOL_ERROR' }; console.error('[ai] tool failed:', JSON.stringify({ name: call.name, message: error.message, code: error.code }).slice(0, 400)); }
      onEvent({ type: 'tool', name: call.name, status: 'done', ok: Boolean(result.ok) });
      functionResults.push({
        type: 'function_result',
        name: call.name,
        call_id: call.callId,
        // Context7 (v1beta streaming): result is an OBJECT with content array
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      });
    }

    // Next turn: array of function_result objects
    input = functionResults;
  }

  return { text: '', toolCount: MAX_ITERATIONS, usage, tooManyTools: true };
}

export function buildHistoryContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const content = String(message.content || '').slice(0, MAX_CONTENT_LEN);
    if (!content) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) { last.parts[0].text += `\n${content}`; } else { contents.push({ role, parts: [{ text: content }] }); }
  }
  return contents;
}

export { executeTool };