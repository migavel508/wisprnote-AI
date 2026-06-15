import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

/**
 * Fast-path trigger: the instant a meeting is saved, kick its knowledge-graph
 * pipeline (extract → embed → link) so everything is ready by the time the user
 * ever opens the graph — instead of waiting up to one cron tick.
 *
 * Implemented as an async self-invoke (`InvocationType: 'Event'`) of THIS Lambda
 * with a targeted single-meeting job, so it never blocks the save response and
 * processes exactly one meeting (no full-sweep overlap / wasted cost). The 2-min
 * cron remains the safety net if a kick is ever dropped.
 */

const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || 'wisprnote-api';
let _client: LambdaClient | null = null;
function client(): LambdaClient {
  if (!_client) _client = new LambdaClient({});
  return _client;
}

export async function kickMeetingPipeline(userId: string, taskId: string): Promise<void> {
  try {
    await client().send(new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: 'Event', // async — returns immediately after enqueue
      Payload: Buffer.from(JSON.stringify({ __job: 'kg-pipe-one', userId, taskId })),
    }));
  } catch (err: any) {
    // Best-effort — the cron sweep will still process the meeting. Never fail the save.
    console.error('kg_pipe_kick_failed', JSON.stringify({ taskId, message: err?.message }));
  }
}
