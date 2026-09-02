const MODULE_ID = "wfrp4e-party-sheet";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TIMEOUT_MS = 15000;

const handlers = new Map();
const pendingRequests = new Map();
let mutationTail = Promise.resolve();
let initialized = false;

// CONCURRENCY-SAFE: single global FIFO promise tail — every party mutation (local or relayed) serializes through this one chain on the active GM's client (BUG-826/831 fix shape).
function enqueue(task) {
  const result = mutationTail.then(task, task);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function failure(reason, detail = null) {
  return { ok: false, reason, ...(detail ? { detail } : {}) };
}

async function execute(operation, payload, requester) {
  const handler = handlers.get(operation);
  if (!handler) return failure("unknown-mutation");
  try {
    return await handler(payload, { requester });
  } catch (err) {
    console.error(`${MODULE_ID} | Authoritative mutation failed`, operation, err);
    return failure("mutation-failed", err?.message ?? String(err));
  }
}

// TRUST-BOUNDARY: acting requester is game.users.get(senderUserId) from Foundry's transport argument, never a payload field (BUG-880 fix, mirrors BUG-547); a request executes only on the addressed active GM; responses resolve only from pending.gmId recorded at request time.
async function onSocketMessage(message, senderUserId) {
  if (!message || message.moduleId !== MODULE_ID) return;

  if (message.kind === "response") {
    if (message.recipientId !== game.user.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    // Only the GM this request was addressed to may resolve it — judged by
    // Foundry's transport-supplied sender identity, never a payload field.
    if (senderUserId !== pending.gmId) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    pending.resolve(message.result);
    return;
  }

  if (message.kind !== "request") return;
  const activeGM = game.users.activeGM;
  if (!game.user.isGM || !activeGM || activeGM.id !== game.user.id || message.gmId !== game.user.id) return;

  // The acting user is the transport-authenticated socket sender; a
  // client-authored payload field could spoof another party member.
  const requester = game.users.get(senderUserId);
  const result = requester?.active
    ? await enqueue(() => execute(message.operation, message.payload, requester))
    : failure("requester-missing");

  game.socket.emit(SOCKET_CHANNEL, {
    moduleId: MODULE_ID,
    kind: "response",
    requestId: message.requestId,
    recipientId: senderUserId,
    result,
  });
}

export function registerMutationHandler(operation, handler) {
  handlers.set(operation, handler);
}

export function initializeMutationQueue() {
  if (initialized) return;
  initialized = true;
  game.socket.on(SOCKET_CHANNEL, onSocketMessage);
}

export async function requestMutation(operation, payload) {
  const activeGM = game.users.activeGM;
  if (game.user.isGM && activeGM?.id === game.user.id) {
    // CONCURRENCY-SAFE: local-GM mutations enqueue on this same FIFO tail as relayed ones, so no local write can jump ahead of a queued relay (active-GM-exclusive execution).
    return enqueue(() => execute(operation, payload, game.user));
  }

  if (!activeGM) return failure("no-active-gm");

  const requestId = foundry.utils.randomID();
  const result = new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(failure("mutation-timeout"));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, timeout, gmId: activeGM.id });
  });

  game.socket.emit(SOCKET_CHANNEL, {
    moduleId: MODULE_ID,
    kind: "request",
    requestId,
    gmId: activeGM.id,
    operation,
    payload,
  });
  return result;
}

Hooks.once("ready", initializeMutationQueue);
