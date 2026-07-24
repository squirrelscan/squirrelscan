// Reactive crawl queue implementation
// Uses Effect's Queue for concurrent, reactive URL processing

import { Effect, Queue, Stream, Duration, Chunk, pipe } from "effect";

import type { ContextRef } from "./context";

import { getContext } from "./context";

// ============================================
// QUEUE TYPES
// ============================================

export interface CrawlQueueItem {
  url: string;
  depth: number;
  parentUrl?: string;
  priority: number; // Lower = higher priority
}

export type CrawlQueue = Queue.Queue<CrawlQueueItem>;

// ============================================
// QUEUE CREATION
// ============================================

/**
 * Create an unbounded crawl queue
 */
export function createCrawlQueue(): Effect.Effect<CrawlQueue, never, never> {
  return Queue.unbounded<CrawlQueueItem>();
}

/**
 * Create a bounded crawl queue with backpressure
 */
export function createBoundedCrawlQueue(
  capacity: number
): Effect.Effect<CrawlQueue, never, never> {
  return Queue.bounded<CrawlQueueItem>(capacity);
}

// ============================================
// QUEUE OPERATIONS
// ============================================

/**
 * Offer a URL to the queue with deduplication check
 */
export function offerUrl(
  queue: CrawlQueue,
  contextRef: ContextRef,
  item: CrawlQueueItem
): Effect.Effect<boolean, never, never> {
  return Effect.gen(function* () {
    const ctx = yield* getContext(contextRef);

    // Check if already visited or in queue
    if (ctx.visitedUrls.has(item.url) || ctx.project.site.pages.has(item.url)) {
      return false;
    }

    // Check if max pages reached
    if (ctx.pagesMaxReached) {
      return false;
    }

    // Add to queue
    yield* Queue.offer(queue, item);
    return true;
  });
}

/**
 * Offer multiple URLs to the queue
 */
export function offerUrls(
  queue: CrawlQueue,
  contextRef: ContextRef,
  items: CrawlQueueItem[]
): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    let added = 0;
    for (const item of items) {
      const wasAdded = yield* offerUrl(queue, contextRef, item);
      if (wasAdded) added++;
    }
    return added;
  });
}

/**
 * Take a URL from the queue (blocks if empty)
 */
export function takeUrl(
  queue: CrawlQueue
): Effect.Effect<CrawlQueueItem, never, never> {
  return Queue.take(queue);
}

/**
 * Take up to N URLs from the queue (non-blocking)
 */
export function takeUpToN(
  queue: CrawlQueue,
  n: number
): Effect.Effect<readonly CrawlQueueItem[], never, never> {
  return Effect.map(Queue.takeUpTo(queue, n), Chunk.toArray);
}

/**
 * Check if queue is empty
 */
export function isQueueEmpty(
  queue: CrawlQueue
): Effect.Effect<boolean, never, never> {
  return Effect.map(Queue.size(queue), (size) => size === 0);
}

/**
 * Get queue size
 */
export function getQueueSize(
  queue: CrawlQueue
): Effect.Effect<number, never, never> {
  return Queue.size(queue);
}

// ============================================
// QUEUE CONSUMER
// ============================================

export interface QueueConsumerOptions {
  concurrency: number;
  delayMs: number;
  onProcess: (item: CrawlQueueItem) => Effect.Effect<void, never, never>;
  onComplete?: () => Effect.Effect<void, never, never>;
}

/**
 * Create a concurrent queue consumer
 * Processes items from the queue with controlled concurrency
 */
export function createQueueConsumer(
  queue: CrawlQueue,
  contextRef: ContextRef,
  options: QueueConsumerOptions
): Effect.Effect<void, never, never> {
  const { concurrency, delayMs, onProcess, onComplete } = options;

  // Process a single item with delay
  const processItem = (item: CrawlQueueItem) =>
    pipe(
      Effect.sleep(Duration.millis(delayMs)),
      Effect.flatMap(() => onProcess(item))
    );

  // Create a worker that continuously takes from queue
  const worker = Effect.gen(function* () {
    while (true) {
      const ctx = yield* getContext(contextRef);

      // Check if we should stop
      if (ctx.pagesMaxReached) {
        break;
      }

      // Try to take an item (with timeout to allow checking stop condition)
      const maybeItem = yield* pipe(
        Queue.take(queue),
        Effect.timeout(Duration.millis(1000)),
        Effect.option
      );

      if (maybeItem._tag === "Some") {
        yield* processItem(maybeItem.value);
      } else {
        // Queue is empty, check if we're done
        const isEmpty = yield* isQueueEmpty(queue);
        if (isEmpty) {
          break;
        }
      }
    }
  });

  // Run multiple workers concurrently
  return pipe(
    Effect.all(
      Array.from({ length: concurrency }, () => worker),
      { concurrency: "unbounded" }
    ),
    Effect.flatMap(() => onComplete?.() ?? Effect.void)
  );
}

// ============================================
// STREAMING QUEUE
// ============================================

/**
 * Create a stream from the queue
 * Useful for reactive processing
 */
export function queueToStream(
  queue: CrawlQueue
): Stream.Stream<CrawlQueueItem, never, never> {
  return Stream.repeatEffect(Queue.take(queue));
}

/**
 * Process queue as a stream with concurrency control
 */
export function processQueueAsStream<A>(
  queue: CrawlQueue,
  processor: (item: CrawlQueueItem) => Effect.Effect<A, never, never>,
  concurrency: number
): Stream.Stream<A, never, never> {
  return pipe(
    queueToStream(queue),
    Stream.mapEffect(processor, { concurrency })
  );
}

// ============================================
// PRIORITY QUEUE HELPERS
// ============================================

/**
 * Create a priority item for sitemap URLs (high priority)
 */
export function createSitemapItem(
  url: string,
  depth: number = 0
): CrawlQueueItem {
  return {
    url,
    depth,
    priority: 0, // Highest priority
  };
}

/**
 * Create a priority item for discovered links
 */
export function createDiscoveredItem(
  url: string,
  depth: number,
  parentUrl: string
): CrawlQueueItem {
  return {
    url,
    depth,
    parentUrl,
    priority: depth, // Priority based on depth
  };
}

// ============================================
// QUEUE DRAINING
// ============================================

/**
 * Drain the queue and return all items
 */
export function drainQueue(
  queue: CrawlQueue
): Effect.Effect<readonly CrawlQueueItem[], never, never> {
  return Effect.map(Queue.takeAll(queue), Chunk.toArray);
}

/**
 * Shutdown the queue (prevents further offers)
 */
export function shutdownQueue(
  queue: CrawlQueue
): Effect.Effect<void, never, never> {
  return Queue.shutdown(queue);
}

/**
 * Check if queue is shutdown
 */
export function isQueueShutdown(
  queue: CrawlQueue
): Effect.Effect<boolean, never, never> {
  return Queue.isShutdown(queue);
}
