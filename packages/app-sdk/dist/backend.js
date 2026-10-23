// @olan-app/sdk/backend: generated from src/backend/index.ts by scripts/build.mjs; do not edit.

// src/api/project-extensions.ts
function projectExtensions(call2) {
  return {
    /**
     * The project's task statuses, and the ones the app defines by its own keys (Phase 6). Members put
     * the app's statuses on tasks but do not rename, recolour or remove them; they stay read-only when
     * the app is removed from the project.
     */
    statuses: {
      /** Every status of the project, in board order. Needs `projects:read`. */
      list(projectId) {
        return call2("project.statuses.list", { projectId });
      },
      /** Adds or updates the app's statuses (≤ 20 per call) and returns all of them. Needs `projects:extend`. */
      define(projectId, statuses) {
        return call2("project.statuses.define", { projectId, statuses });
      },
      /** Removes one of the app's statuses; its tasks move to `replacementKey` or the first status of the same kind. Needs `projects:extend`. */
      remove(projectId, key, options = {}) {
        return call2("project.statuses.remove", { projectId, key, ...options });
      }
    },
    /** The project's labels, and the ones the app defines (members use them, the app manages them). */
    labels: {
      /** Needs `projects:read`. */
      list(projectId) {
        return call2("project.labels.list", { projectId });
      },
      /** Adds or updates the app's labels (≤ 20 per call). Needs `projects:extend`. */
      define(projectId, labels) {
        return call2("project.labels.define", { projectId, labels });
      },
      /** Removes one of the app's labels from the project and from its tasks and issues. Needs `projects:extend`. */
      async remove(projectId, key) {
        await call2("project.labels.remove", { projectId, key });
      }
    },
    /**
     * The project's custom fields, and the ones the app defines by its own keys. Members fill in the
     * app's fields on tasks and issues but do not change or remove them; their values stay read-only
     * when the app is removed from the project.
     */
    fields: {
      /** Every field of the project, in order. Needs `projects:read`. */
      list(projectId) {
        return call2("project.fields.list", { projectId });
      },
      /** Adds or updates the app's fields (≤ 20 per call) and returns all of them. Needs `projects:extend`. */
      define(projectId, fields) {
        return call2("project.fields.define", { projectId, fields });
      },
      /** Removes one of the app's fields and its values. Needs `projects:extend`. */
      async remove(projectId, key) {
        await call2("project.fields.remove", { projectId, key });
      },
      /** A task's or issue's values, keyed by field key (fields without a key: by id). Needs `projects:read`. */
      values(projectId, target) {
        return call2("project.fields.values", { projectId, target });
      },
      /**
       * Sets values of a task or issue (`{ <field key or id>: value }`; `null` clears one) and returns
       * all of its values. Needs `tasks:write`.
       */
      setValues(projectId, target, values) {
        return call2("project.fields.setValues", { projectId, target, values });
      }
    },
    /**
     * The app's records linked to tasks and issues (Phase 6). The card the app draws shows on the task
     * or issue; its `open` buttons open the app's `record.card` surface. Through a link the app moves
     * the task to another status (or opens and closes the issue); the project feed shows the change
     * under the app.
     */
    links: {
      /** The app's links in the project, optionally of one task or issue. Needs `projects:read`. */
      list(projectId, target) {
        return call2("project.links.list", { projectId, ...target ? { target } : {} });
      },
      /** Links a record (or replaces the card of an existing link). Needs `tasks:write`. */
      upsert(projectId, input) {
        return call2("project.links.upsert", { projectId, ...input });
      },
      /** Needs `tasks:write`. */
      async remove(projectId, linkId) {
        await call2("project.links.remove", { projectId, linkId });
      },
      /** Moves the linked task (or opens/closes the linked issue). Needs `tasks:write`. */
      setStatus(projectId, linkId, input) {
        return call2("project.links.setStatus", { projectId, linkId, ...input });
      }
    },
    /** The app's layer of the project calendar (shown while the app is enabled in the project). */
    calendar: {
      /** The app's items, optionally between `from` and `to` (≤ 366 days). Needs `projects:read`. */
      list(projectId, range = {}) {
        return call2("project.calendar.list", { projectId, ...range });
      },
      /** Adds or replaces the item of `externalId` (≤ 500 per project). Needs `projects:extend`. */
      upsert(projectId, item) {
        return call2("project.calendar.upsert", { projectId, ...item });
      },
      /** Needs `projects:extend`. */
      async remove(projectId, externalId) {
        await call2("project.calendar.remove", { projectId, externalId });
      }
    },
    activity: {
      /** A line of the app in the project feed (1–280 characters), optionally about a task or issue. Needs `projects:extend`. */
      async post(projectId, text, options = {}) {
        await call2("project.activity.post", { projectId, text, ...options.target ? { target: options.target } : {} });
      }
    },
    /**
     * Approval requests: the approvers (project members who may change the project) find them in their
     * approval box; the app hears the outcome as `project.approval.decided`.
     */
    approvals: {
      /** Needs `projects:read`. */
      list(projectId, options = {}) {
        return call2("project.approvals.list", { projectId, ...options });
      },
      /** Needs `projects:extend`. */
      request(projectId, input) {
        return call2("project.approvals.request", { projectId, ...input });
      },
      /** Cancels a pending request. Needs `projects:extend`. */
      cancel(projectId, approvalId) {
        return call2("project.approvals.cancel", { projectId, approvalId });
      }
    }
  };
}

// src/backend/index.ts
function defineBackend(definition) {
  return Object.freeze({ ...definition, $olanBackend: 1 });
}
function isBackendModule(value) {
  return typeof value === "object" && value !== null && value.$olanBackend === 1;
}
var OlanBackendError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "OlanBackendError";
    this.code = code;
  }
};
var BackendUnavailableError = class extends OlanBackendError {
  constructor(what) {
    super("backend_unavailable", `${what} only works inside the Olan backend runtime (manifest "server"); from the UI use olan.backend.call`);
    this.name = "BackendUnavailableError";
  }
};
function isOlanBackendError(error, code) {
  if (typeof error !== "object" || error === null) return false;
  const name = error.name;
  const shaped = error instanceof OlanBackendError || (name === "OlanBackendError" || name === "BackendUnavailableError") && typeof error.code === "string";
  return shaped && (code === void 0 || error.code === code);
}
function bridge(method) {
  const candidate = globalThis.__olan;
  if (!candidate || typeof candidate.call !== "function") throw new BackendUnavailableError(`olan.${method}`);
  return candidate;
}
async function call(method, params) {
  const host = bridge(method);
  let text;
  try {
    text = await host.call(method, JSON.stringify(params ?? {}));
  } catch (error) {
    const failure = error;
    const code = typeof failure?.code === "string" ? failure.code : "host_error";
    const message = typeof failure?.message === "string" ? failure.message : String(error);
    throw new OlanBackendError(code, message);
  }
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new OlanBackendError("host_error", `olan.${method}: the host answered with invalid JSON`);
  }
}
function collection(name) {
  if (typeof name !== "string" || name.length === 0) throw new OlanBackendError("invalid_params", "olan.db.collection needs a collection name");
  return Object.freeze({
    name,
    insert: (data) => call("db.insert", { collection: name, data }),
    get: (id) => call("db.get", { collection: name, id }),
    query: (query = {}) => call("db.query", { collection: name, ...query }),
    update: (id, patch, options) => call("db.update", { collection: name, id, patch, revision: options?.revision }),
    delete: (id, options = {}) => call("db.delete", { collection: name, id, ...options.revision === void 0 ? {} : { revision: options.revision } }).then(() => void 0),
    count: (where) => call("db.count", { collection: name, ...where === void 0 ? {} : { where } })
  });
}
var USERS_PER_CALL = 100;
var api = {
  secrets: Object.freeze({
    /**
     * A `secret: true` setting of the installation, or `null` when it is not set. Only backend
     * code can read secrets: for apps with `server`, `olan.settings.get()` in the UI (and here)
     * answers `null` for them. Host method `secrets.get` `{ name }`.
     */
    get: (name) => call("secrets.get", { name })
  }),
  settings: Object.freeze({
    /** The installation's settings; `secret: true` fields are `null` (use `olan.secrets.get`). */
    get: () => call("settings.get", {})
  }),
  /** The app database (manifest `data`, permission `db`); same API as the UI `olan.db`. */
  db: Object.freeze({ collection }),
  http: Object.freeze({
    /** A request through Olan; only granted `http:<host>` permissions are reachable (`http_blocked`). */
    async fetch(url, init = {}) {
      const response = await call("http.fetch", { url, ...init });
      return {
        ...response,
        json() {
          try {
            return JSON.parse(response.body);
          } catch {
            throw new OlanBackendError("invalid_params", "The response body is not JSON");
          }
        }
      };
    }
  }),
  /** Phase 6: the app's configuration of a project it is enabled in (same API as the UI `olan.project`). */
  project: Object.freeze({
    config: Object.freeze({
      get: (projectId) => call("project.config.get", { projectId }),
      set: (projectId, value, options = {}) => call("project.config.set", { projectId, value, ...options.revision === void 0 ? {} : { revision: options.revision } })
    }),
    // Phase 6 (second wave): statuses, labels, custom fields, record links, calendar layer, feed lines, approvals.
    ...projectExtensions((method, params) => call(method, params))
  }),
  projects: Object.freeze({
    list: (options = {}) => call("projects.list", options),
    get: (projectId) => call("projects.get", { projectId }),
    tasks: (projectId, options = {}) => call("projects.tasks", { projectId, ...options }),
    updateTask: (projectId, taskId, change) => call("projects.updateTask", { projectId, taskId, ...change }),
    createTask: (projectId, task) => call("projects.createTask", { projectId, ...task }),
    deleteTask: (projectId, taskId, options) => call("projects.deleteTask", { projectId, taskId, revision: options?.revision }).then(() => void 0),
    deleteList: (projectId, listId, options) => call("projects.deleteList", { projectId, listId, revision: options?.revision }).then(() => void 0),
    create: (input) => call("projects.create", input),
    archive: (projectId) => call("projects.archive", { projectId }).then(() => void 0)
  }),
  users: Object.freeze({
    /** Directory entries (`users:read`); duplicates asked once, more than 100 ids split into several calls. */
    async get(ids) {
      const unique = [...new Set(ids)];
      const batches = [];
      for (let start = 0; start < unique.length; start += USERS_PER_CALL) batches.push(unique.slice(start, start + USERS_PER_CALL));
      const results = await Promise.all(batches.map((batch) => call("users.get", { ids: batch })));
      return results.flatMap((result) => result.users);
    }
  }),
  chat: Object.freeze({
    conversations: () => call("chat.conversations", {}),
    messages: (conversationId, options = {}) => call("chat.messages", { conversationId, ...options }),
    postCard: (input) => call("chat.postCard", input),
    updateCard: (messageId, card) => call("chat.updateCard", { messageId, card })
  }),
  calendar: Object.freeze({
    calendars: () => call("calendar.calendars", {}).then((result) => result.calendars),
    events: (query) => call("calendar.events", query).then((result) => result.events),
    createEvent: (input) => call("calendar.createEvent", input),
    updateEvent: (eventId, patch) => call("calendar.updateEvent", { eventId, patch }),
    deleteEvent: (eventId) => call("calendar.deleteEvent", { eventId }).then(() => void 0)
  }),
  contacts: Object.freeze({
    addressBooks: () => call("contacts.addressBooks", {}).then((result) => result.addressBooks),
    search: (query, options = {}) => call("contacts.search", { query, ...options }).then((result) => result.contacts),
    create: (input) => call("contacts.create", input),
    update: (contactId, patch) => call("contacts.update", { contactId, patch }),
    delete: (contactId) => call("contacts.delete", { contactId }).then(() => void 0)
  }),
  meetings: Object.freeze({
    get: (meetingId) => call("meetings.get", { meetingId })
  })
};
var olan = Object.freeze(api);
export {
  BackendUnavailableError,
  OlanBackendError,
  defineBackend,
  isBackendModule,
  isOlanBackendError,
  olan
};
