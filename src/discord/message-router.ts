/**
 * Deterministic message classifier for Discord messages.
 * Routes to specialized system prompts before falling back to general.
 * Reduces token usage by using focused prompts for known patterns.
 */

export type MessageIntent = 'status' | 'task_mgmt' | 'report' | 'image' | 'general';

/** Classify a Discord message by intent using deterministic regex matching. */
export function classifyMessage(text: string): MessageIntent {
  const lower = text.toLowerCase();

  // Status queries — short messages asking about system state
  if (/\b(status|how.*going|what.*up|check|health|running)\b/.test(lower) && lower.length < 100) {
    return 'status';
  }

  // Task management
  if (/\b(create.*task|schedule|set up.*task|update.*task|list.*task|cancel.*task|task.*#?\d+)\b/.test(lower)) {
    return 'task_mgmt';
  }

  // Report requests
  if (/\b(report|run.*report|generate.*report|daily.*report|send.*report)\b/.test(lower)) {
    return 'report';
  }

  // Image generation
  if (/\b(generate.*image|create.*image|make.*image|draw|photo of|picture of|image of)\b/.test(lower)) {
    return 'image';
  }

  return 'general';
}

/** Get a focused system prompt suffix for a given intent. */
export function getIntentGuidance(intent: MessageIntent): string | null {
  switch (intent) {
    case 'status':
      return 'This is a status query. Use the status MCP tool and respond concisely. Do not run long operations.';
    case 'task_mgmt':
      return 'This is a task management request. Use task_create, task_update, task_list, or task_complete tools as appropriate.';
    case 'report':
      return 'This is a report request. Check for existing scheduled tasks first. If a manual run is requested, use task_create_from_template.';
    case 'image':
      return 'This is an image generation request. Use the image_generate MCP tool.';
    default:
      return null;
  }
}
