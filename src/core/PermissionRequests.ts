import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { Permissions } from './ClientHandlers';
import { log, logError } from './Log';

/** The `acp.autoApprovePermissions` setting. */
export type AutoApprove = 'ask' | 'allowAll';

export interface PermissionChooser {
  /** Read for every permission request, so a changed setting applies to the next one. */
  autoApprove(): AutoApprove;
  /** Ask the user to choose one of the options; undefined when they dismiss the choice. */
  choose(title: string, options: readonly PermissionOption[]): Promise<string | undefined>;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/**
 * Answers the agent's permission requests one at a time, so concurrent requests
 * wait their turn instead of competing for the user's attention.
 */
export class PermissionRequests implements Permissions {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly chooser: PermissionChooser) {}

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const answer = this.queue.then(() => this.answer(params));
    this.queue = answer.catch(() => {});
    return answer.catch((error: unknown) => {
      logError('Permission request failed', error);
      return CANCELLED;
    });
  }

  private async answer(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall.title || 'Permission Request';
    const autoApprove = this.chooser.autoApprove();
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    if (autoApprove === 'allowAll') {
      const allow = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
      if (allow) {
        return selected(allow.optionId);
      }
    }

    const optionId = await this.chooser.choose(title, params.options);
    if (optionId === undefined) {
      log('Permission cancelled by user');
      return CANCELLED;
    }
    log(`Permission selected: ${optionId}`);
    return selected(optionId);
  }
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}
