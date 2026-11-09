import type { CapabilityPluginPolicy } from "./capability.js";
import type { McpServerConfig } from "./mcp.js";

export type RuntimeKind = "native" | "codex" | "claude-code" | "cursor-sdk" | "openhands" | "pi";

export type TaskKind =
  | "simple_qa"
  | "research"
  | "architecture"
  | "coding"
  | "debugging"
  | "artifact"
  | "private_analysis"
  | "workflow";

export type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ProviderKind =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "azure-openai"
  | "bedrock"
  | "local"
  | "codex-cli";

export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: ReasoningLevel;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ProviderConfig {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly defaultModel: string;
  readonly timeoutMs?: number;
}

export interface RuntimeConfig {
  readonly id: RuntimeKind | string;
  readonly enabled: boolean;
  readonly provider: string;
  readonly routes: Partial<Record<TaskKind, ModelRoute>>;
}

export interface RoutingPolicy {
  readonly oneRuntimePerRun: true;
  readonly defaultRuntime: string;
  readonly preferLocalForSensitive: boolean;
  readonly maxCostUsdPerRun?: number;
  readonly approvalRequiredAboveUsd?: number;
  /**
   * Governed fallback routes tried in order when the primary route fails.
   * Every fallback attempt is recorded as system_check evidence on the episode;
   * the harness never switches models silently.
   */
  readonly fallbacks?: ModelRoute[];
}

export interface MusterConfig {
  readonly version: 1;
  /** User policy hooks by event (see config-hooks.ts). */
  readonly hooks?: import("./config-hooks.js").HookRules;
  readonly providers: Record<string, ProviderConfig>;
  readonly runtimes: Record<string, RuntimeConfig>;
  readonly routing: RoutingPolicy;
  /**
   * Agent-specific overlays. For skills, defaults.skills is the inherited
   * baseline; an agent entry with skills set is final and does not merge.
   */
  readonly agents?: AgentsConfig;
  /**
   * Skill runtime configuration. Env/API-key values are scoped to the host
   * process for a selected skill's run and restored afterward.
   */
  readonly skills?: SkillRuntimeConfig;
  /**
   * In-repo plugin/capability policy. Deny wins over allow; non-empty allow is
   * final; slot owners are exclusive. This replaces OpenClaw-style live plugin
   * installs with auditable local manifests.
   */
  readonly plugins?: CapabilityPluginPolicy;
  /**
   * Tool exposure policy. This keeps migrated tool/MCP intent explicit without
   * auto-enabling broad ambient tool access.
   */
  readonly tools?: ToolRuntimeConfig;
  /**
   * Optional per-profile identity. Injected into the model's SYSTEM prompt (never
   * the user turn) so the agent knows what it is — closing the "didn't know it's
   * muster" gap — without being narrated back (agent-rules rule 6). Populated by
   * migration from the source OpenClaw channel; absent on the default profile.
   */
  readonly identity?: ProfileIdentity;
  /**
   * Durable-memory write policy. Enforced in `addMemory` (packages/core/src/memory.ts),
   * not by prompt text: a persona string can be ignored by a model, a thrown
   * MemoryPolicyError cannot. Absent means "auto" so existing profiles keep
   * today's behaviour.
   */
  readonly memory?: MemoryPolicyConfig;
}

/** "auto": write freely. "ask": every write needs a consent receipt. "never": only explicit user requests. */
export type MemoryWritePolicy = "auto" | "ask" | "never";

export interface MemoryPolicyConfig {
  readonly policy: MemoryWritePolicy;
}

export interface AgentsConfig {
  readonly defaults?: AgentDefaultsConfig;
  readonly list?: readonly AgentConfig[];
}

export interface AgentDefaultsConfig {
  readonly skills?: readonly string[];
}

export interface AgentConfig {
  readonly id: string;
  readonly skills?: readonly string[];
}

export interface SkillRuntimeConfig {
  readonly load?: SkillLoadConfig;
  readonly entries?: Record<string, SkillRuntimeEntryConfig>;
}

export interface SkillLoadConfig {
  readonly extraDirs?: readonly string[];
  /**
   * Disabled by default: shared home skill roots are useful for migration, but
   * profile/workspace-local roots are safer and more reproducible.
   */
  readonly includeHomeDirs?: boolean;
}

export interface SkillSecretRef {
  readonly source: "env";
  readonly provider?: string;
  readonly id: string;
}

export interface SkillRuntimeEntryConfig {
  readonly enabled?: boolean;
  readonly env?: Record<string, string>;
  readonly apiKey?: string | SkillSecretRef;
  readonly config?: Record<string, unknown>;
}

export interface ToolRuntimeConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, McpServerConfig>>;
  };
  readonly entries?: Readonly<Record<string, ToolRuntimeEntryConfig>>;
}

export interface ToolRuntimeEntryConfig {
  readonly enabled?: boolean;
  readonly source?: string;
  readonly config?: Record<string, unknown>;
}

export interface ProfileIdentity {
  readonly name: string;
  readonly description?: string;
  readonly persona?: string;
}

export interface RunRequest {
  readonly prompt: string;
  readonly runtime?: string;
  readonly taskKind?: TaskKind;
  readonly sensitive?: boolean;
  readonly cwd?: string;
}

export interface RunPlan {
  readonly runId: string;
  readonly taskKind: TaskKind;
  readonly runtimeId: string;
  readonly route: ModelRoute;
  readonly sensitive: boolean;
  readonly createdAt: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface EpisodeRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly taskKind: TaskKind;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly model: string;
  readonly reasoning?: ReasoningLevel;
  readonly responseText: string;
  readonly evidence: EvidenceRecord[];
  readonly outcome?: OutcomeSignal;
}

export interface EvidenceRecord {
  readonly kind: "model_response" | "tool_result" | "test_result" | "user_action" | "system_check";
  readonly label: string;
  readonly status: "observed" | "passed" | "failed" | "unknown";
  readonly detail?: string;
}

export interface OutcomeSignal {
  readonly kind: "completed" | "failed" | "abandoned" | "unknown";
  readonly detail?: string;
}

export type FeedbackValue = "useful" | "not_useful";

export interface FeedbackInput {
  readonly episodeId: string;
  readonly value: FeedbackValue;
  readonly reason?: string;
  readonly correctAndWorked?: boolean;
}

export type FeedbackAdjudication =
  | "verified_success"
  | "verified_failure"
  | "user_disputed_evidence_correct"
  | "intent_mismatch"
  | "poor_explanation"
  | "retrieval_or_tool_failure"
  | "model_hallucination"
  | "insufficient_evidence"
  | "likely_unjustified_feedback"
  | "needs_expert_review";

export interface FeedbackRecord extends FeedbackInput {
  readonly createdAt: string;
  readonly adjudication: FeedbackAdjudication;
  readonly learningCandidates: LearningCandidate[];
}

export interface LearningCandidate {
  readonly kind: "memory" | "eval" | "policy" | "tool_fix" | "prompt_or_routing";
  readonly risk: "low" | "medium" | "high";
  readonly summary: string;
  readonly autoApply: boolean;
}

export type MemoryScopeKind = "global" | "tenant" | "workspace" | "user" | "pairing" | "session" | "role" | "persona";

export interface MemoryScope {
  readonly kind: MemoryScopeKind;
  readonly id: string;
}

export interface ContextObject {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly sourceUri?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly observedAt: string;
  readonly confidence: number;
  readonly provenance: string[];
  readonly scopes: MemoryScope[];
  readonly redactionState: "none" | "redacted" | "hashed" | "blocked";
  readonly feedbackScore?: number;
  readonly links?: string[];
}
