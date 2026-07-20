const MODULE_ID = "wfrp4e-party-sheet";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TIMEOUT_MS = 15000;

const handlers = new Map();
const pendingRequests = new Map();
let mutationTail = Promise.resolve();
let initialized = false;

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

async function onSocketMessage(message) {
  if (!message || message.moduleId !== MODULE_ID) return;

  if (message.kind === "response") {
    if (message.recipientId !== game.user.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    pending.resolve(message.result);
    return;
  }

  if (message.kind !== "request") return;
  const activeGM = game.users.activeGM;
  if (!game.user.isGM || !activeGM || activeGM.id !== game.user.id || message.gmId !== game.user.id) return;

  const requester = game.users.get(message.requesterId);
  const result = requester?.active
    ? await enqueue(() => execute(message.operation, message.payload, requester))
    : failure("requester-missing");

  game.socket.emit(SOCKET_CHANNEL, {
    moduleId: MODULE_ID,
    kind: "response",
    requestId: message.requestId,
    recipientId: message.requesterId,
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
    return enqueue(() => execute(operation, payload, game.user));
  }

  if (!activeGM) return failure("no-active-gm");

  const requestId = foundry.utils.randomID();
  const result = new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(failure("mutation-timeout"));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, timeout });
  });

  game.socket.emit(SOCKET_CHANNEL, {
    moduleId: MODULE_ID,
    kind: "request",
    requestId,
    requesterId: game.user.id,
    gmId: activeGM.id,
    operation,
    payload,
  });
  return result;
}

Hooks.once("ready", initializeMutationQueue);
