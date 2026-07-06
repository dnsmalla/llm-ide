// In-memory task store keyed by `${userId}:${sessionId}`.
// Tasks are ephemeral — they exist only for the current conversation.
// No persistence needed: if the backend restarts the user starts a new conversation anyway.

const store = new Map(); // key → Task[]

function key(userId, sessionId) {
  return `${userId ?? 'anon'}:${sessionId ?? 'default'}`;
}

export function sessionTaskStore() {
  return {
    createTask(userId, sessionId, title) {
      const k = key(userId, sessionId);
      const tasks = store.get(k) ?? [];
      const task = {
        id: String(tasks.length + 1),
        title,
        status: 'pending',
        createdAt: Date.now(),
      };
      tasks.push(task);
      store.set(k, tasks);
      return task;
    },

    updateTask(userId, sessionId, taskId, { status, title }) {
      const k = key(userId, sessionId);
      const tasks = store.get(k) ?? [];
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return { error: `no task with id '${taskId}'` };
      if (status) task.status = status;
      if (title) task.title = title;
      return task;
    },

    listTasks(userId, sessionId) {
      return store.get(key(userId, sessionId)) ?? [];
    },

    hasPendingWork(userId, sessionId) {
      const tasks = store.get(key(userId, sessionId)) ?? [];
      return tasks.some((t) => t.status === 'pending' || t.status === 'in_progress');
    },

    clearSession(userId, sessionId) {
      store.delete(key(userId, sessionId));
    },
  };
}

// Singleton — all requests share the same in-memory store.
export const tasks = sessionTaskStore();
