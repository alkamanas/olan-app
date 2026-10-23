import type {
  ProjectApproval,
  ProjectApprovalState,
  ProjectCalendarItem,
  ProjectCalendarItemInput,
  ProjectField,
  ProjectFieldDefinition,
  ProjectFieldValue,
  ProjectFieldValues,
  ProjectLabel,
  ProjectLabelDefinition,
  ProjectStatus,
  ProjectStatusDefinition,
  RecordLink,
  RecordTarget,
  RequestApprovalInput,
  RpcMethodName,
  RpcMethods,
  SetLinkedStatusInput,
  SetLinkedStatusResult,
  UpsertRecordLinkInput,
} from './types';

/** A typed call of one RPC method (the UI's `rpc`, backend code's host call). */
export type ProjectCall = <M extends RpcMethodName>(method: M, params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']>;

/**
 * `olan.project.*` beyond `config` (Phase 6, second wave): what the app adds to the projects it is
 * enabled in. The same API in the app's UI and in its backend code.
 */
export function projectExtensions(call: ProjectCall) {
  return {
    /**
     * The project's task statuses, and the ones the app defines by its own keys (Phase 6). Members put
     * the app's statuses on tasks but do not rename, recolour or remove them; they stay read-only when
     * the app is removed from the project.
     */
    statuses: {
      /** Every status of the project, in board order. Needs `projects:read`. */
      list(projectId: string): Promise<ProjectStatus[]> {
        return call('project.statuses.list', { projectId });
      },
      /** Adds or updates the app's statuses (≤ 20 per call) and returns all of them. Needs `projects:extend`. */
      define(projectId: string, statuses: ProjectStatusDefinition[]): Promise<ProjectStatus[]> {
        return call('project.statuses.define', { projectId, statuses });
      },
      /** Removes one of the app's statuses; its tasks move to `replacementKey` or the first status of the same kind. Needs `projects:extend`. */
      remove(projectId: string, key: string, options: { replacementKey?: string } = {}): Promise<{ movedTasks: number }> {
        return call('project.statuses.remove', { projectId, key, ...options });
      },
    },
    /** The project's labels, and the ones the app defines (members use them, the app manages them). */
    labels: {
      /** Needs `projects:read`. */
      list(projectId: string): Promise<ProjectLabel[]> {
        return call('project.labels.list', { projectId });
      },
      /** Adds or updates the app's labels (≤ 20 per call). Needs `projects:extend`. */
      define(projectId: string, labels: ProjectLabelDefinition[]): Promise<ProjectLabel[]> {
        return call('project.labels.define', { projectId, labels });
      },
      /** Removes one of the app's labels from the project and from its tasks and issues. Needs `projects:extend`. */
      async remove(projectId: string, key: string): Promise<void> {
        await call('project.labels.remove', { projectId, key });
      },
    },
    /**
     * The project's custom fields, and the ones the app defines by its own keys. Members fill in the
     * app's fields on tasks and issues but do not change or remove them; their values stay read-only
     * when the app is removed from the project.
     */
    fields: {
      /** Every field of the project, in order. Needs `projects:read`. */
      list(projectId: string): Promise<ProjectField[]> {
        return call('project.fields.list', { projectId });
      },
      /** Adds or updates the app's fields (≤ 20 per call) and returns all of them. Needs `projects:extend`. */
      define(projectId: string, fields: ProjectFieldDefinition[]): Promise<ProjectField[]> {
        return call('project.fields.define', { projectId, fields });
      },
      /** Removes one of the app's fields and its values. Needs `projects:extend`. */
      async remove(projectId: string, key: string): Promise<void> {
        await call('project.fields.remove', { projectId, key });
      },
      /** A task's or issue's values, keyed by field key (fields without a key: by id). Needs `projects:read`. */
      values(projectId: string, target: RecordTarget): Promise<ProjectFieldValues> {
        return call('project.fields.values', { projectId, target });
      },
      /**
       * Sets values of a task or issue (`{ <field key or id>: value }`; `null` clears one) and returns
       * all of its values. Needs `tasks:write`.
       */
      setValues(projectId: string, target: RecordTarget, values: Record<string, ProjectFieldValue | null>): Promise<ProjectFieldValues> {
        return call('project.fields.setValues', { projectId, target, values });
      },
    },
    /**
     * The app's records linked to tasks and issues (Phase 6). The card the app draws shows on the task
     * or issue; its `open` buttons open the app's `record.card` surface. Through a link the app moves
     * the task to another status (or opens and closes the issue); the project feed shows the change
     * under the app.
     */
    links: {
      /** The app's links in the project, optionally of one task or issue. Needs `projects:read`. */
      list(projectId: string, target?: RecordTarget): Promise<RecordLink[]> {
        return call('project.links.list', { projectId, ...(target ? { target } : {}) });
      },
      /** Links a record (or replaces the card of an existing link). Needs `tasks:write`. */
      upsert(projectId: string, input: UpsertRecordLinkInput): Promise<RecordLink> {
        return call('project.links.upsert', { projectId, ...input });
      },
      /** Needs `tasks:write`. */
      async remove(projectId: string, linkId: string): Promise<void> {
        await call('project.links.remove', { projectId, linkId });
      },
      /** Moves the linked task (or opens/closes the linked issue). Needs `tasks:write`. */
      setStatus(projectId: string, linkId: string, input: SetLinkedStatusInput): Promise<SetLinkedStatusResult> {
        return call('project.links.setStatus', { projectId, linkId, ...input });
      },
    },
    /** The app's layer of the project calendar (shown while the app is enabled in the project). */
    calendar: {
      /** The app's items, optionally between `from` and `to` (≤ 366 days). Needs `projects:read`. */
      list(projectId: string, range: { from?: string; to?: string } = {}): Promise<ProjectCalendarItem[]> {
        return call('project.calendar.list', { projectId, ...range });
      },
      /** Adds or replaces the item of `externalId` (≤ 500 per project). Needs `projects:extend`. */
      upsert(projectId: string, item: ProjectCalendarItemInput): Promise<ProjectCalendarItem> {
        return call('project.calendar.upsert', { projectId, ...item });
      },
      /** Needs `projects:extend`. */
      async remove(projectId: string, externalId: string): Promise<void> {
        await call('project.calendar.remove', { projectId, externalId });
      },
    },
    activity: {
      /** A line of the app in the project feed (1–280 characters), optionally about a task or issue. Needs `projects:extend`. */
      async post(projectId: string, text: string, options: { target?: RecordTarget | null } = {}): Promise<void> {
        await call('project.activity.post', { projectId, text, ...(options.target ? { target: options.target } : {}) });
      },
    },
    /**
     * Approval requests: the approvers (project members who may change the project) find them in their
     * approval box; the app hears the outcome as `project.approval.decided`.
     */
    approvals: {
      /** Needs `projects:read`. */
      list(projectId: string, options: { state?: ProjectApprovalState | 'all' } = {}): Promise<ProjectApproval[]> {
        return call('project.approvals.list', { projectId, ...options });
      },
      /** Needs `projects:extend`. */
      request(projectId: string, input: RequestApprovalInput): Promise<ProjectApproval> {
        return call('project.approvals.request', { projectId, ...input });
      },
      /** Cancels a pending request. Needs `projects:extend`. */
      cancel(projectId: string, approvalId: string): Promise<ProjectApproval> {
        return call('project.approvals.cancel', { projectId, approvalId });
      },
    },
  };
}
