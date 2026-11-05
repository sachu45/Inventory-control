import { BadRequestException, PipeTransform } from '@nestjs/common';
import { isWorkflowFeature, WORKFLOW_FEATURES, type WorkflowFeature } from './feature-flags.service';

/** Route param `:feature` must be a known workflow feature; anything else is 400. */
export class ParseWorkflowFeaturePipe implements PipeTransform<unknown, WorkflowFeature> {
  transform(value: unknown): WorkflowFeature {
    if (!isWorkflowFeature(value)) {
      throw new BadRequestException({
        code: 'UNKNOWN_FEATURE_FLAG',
        message: `Unknown feature flag. Known flags: ${WORKFLOW_FEATURES.join(', ')}`,
      });
    }
    return value;
  }
}

/** Body of a flag write: `enabled` must be a boolean, not merely truthy. */
export function parseEnabled(body: unknown): boolean {
  const enabled = (body as { enabled?: unknown } | null | undefined)?.enabled;
  if (typeof enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
  return enabled;
}
