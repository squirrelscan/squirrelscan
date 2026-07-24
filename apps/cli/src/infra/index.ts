// Infrastructure module exports
// Central export point for all infrastructure primitives

// Errors
export {
  FetchError,
  CrawlError,
  ParseError,
  RuleError,
  WorkflowError,
  type CrawlErrorType,
  type GraphError,
  isRetryable,
  getRetryDelay,
} from "./errors";

// Retry
export {
  exponentialBackoff,
  rateLimitSchedule,
  transientSchedule,
  fixedDelaySchedule,
  defaultRetryPolicy,
  aggressiveRetryPolicy,
  createScheduleFromPolicy,
  withRetry,
  withRateLimitRetry,
  withFallback,
  withTimeout,
  type RetryPolicy,
  type CircuitBreakerState,
  createCircuitBreaker,
} from "./retry";

// Context
export {
  // Types
  type LinkPosition,
  type LinkAppearance,
  type SiteLink,
  type PageLinkRef,
  type ImageAppearance,
  type SiteImage,
  type PageImageRef,
  type ParsedPageData,
  type PageRaw,
  type Page,
  type SiteGraph,
  type Settings,
  type RuleConfig,
  type NodeExecution,
  type AuditContext,
  type ContextRef,

  // Creation
  createRuleConfig,
  createInitialContext,
  createContextRef,
  createCrawlQueue as createContextCrawlQueue,

  // Operations
  updateContext,
  getContext,
  subscribeToChanges,

  // Mutation helpers
  addPage,
  addLink,
  addImage,
  markVisited,
  addToQueue,
  recordFailure,
  updateLinkStatus,
  setRobotsTxt,
  addSitemap,
  startNodeExecution,
  completeNodeExecution,
} from "./context";

// Queue
export {
  type CrawlQueueItem,
  type CrawlQueue,
  type QueueConsumerOptions,
  createCrawlQueue,
  createBoundedCrawlQueue,
  offerUrl,
  offerUrls,
  takeUrl,
  takeUpToN,
  isQueueEmpty,
  getQueueSize,
  createQueueConsumer,
  queueToStream,
  processQueueAsStream,
  createSitemapItem,
  createDiscoveredItem,
  drainQueue,
  shutdownQueue,
  isQueueShutdown,
} from "./queue";
