package analytics

import (
	"context"
	"sync"
	"testing"
	"time"
)

type blockingMetricCollector struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newBlockingMetricCollector() *blockingMetricCollector {
	return &blockingMetricCollector{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (b *blockingMetricCollector) Name() string {
	return "blocking"
}

func (b *blockingMetricCollector) Interval() time.Duration {
	return time.Millisecond
}

func (b *blockingMetricCollector) Collect(ctx context.Context) ([]MetricSample, error) {
	b.once.Do(func() {
		close(b.entered)
	})
	select {
	case <-b.release:
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func waitForChannel(t *testing.T, ch <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(timeout):
		t.Fatalf("timed out after %s", timeout)
	}
}

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition was not met after %s", timeout)
}

func waitForCollectorStopped(t *testing.T, c *Collector) {
	t.Helper()
	waitForCondition(t, time.Second, func() bool {
		c.lifecycleMu.Lock()
		defer c.lifecycleMu.Unlock()
		return !c.running && c.doneCh == nil
	})
}

func TestCollectorStartIsIdempotentWhenCalledRepeatedly(t *testing.T) {
	collector := NewCollector()
	collector.flushInterval = 10 * time.Millisecond
	blocker := newBlockingMetricCollector()
	collector.RegisterCollector(blocker)
	collector.Record(MetricSample{Name: "boot"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for i := 0; i < 20; i++ {
		collector.Start(ctx)
	}
	waitForChannel(t, blocker.entered, time.Second)

	collector.Stop()
	close(blocker.release)
	waitForCollectorStopped(t, collector)

	collector.Record(MetricSample{Name: "after-stop"})
	time.Sleep(3 * collector.flushInterval)

	if got := collector.Stats().FlushedSamples; got != 1 {
		t.Fatalf("expected no flush after Stop, got %d flushed samples", got)
	}
}

func TestCollectorConcurrentStartIsRaceSafe(t *testing.T) {
	collector := NewCollector()
	collector.flushInterval = 10 * time.Millisecond
	blocker := newBlockingMetricCollector()
	collector.RegisterCollector(blocker)
	collector.Record(MetricSample{Name: "boot"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			collector.Start(ctx)
		}()
	}
	wg.Wait()
	waitForChannel(t, blocker.entered, time.Second)

	collector.Stop()
	close(blocker.release)
	waitForCollectorStopped(t, collector)

	collector.Record(MetricSample{Name: "after-stop"})
	time.Sleep(3 * collector.flushInterval)

	if got := collector.Stats().FlushedSamples; got != 1 {
		t.Fatalf("expected exactly one active flush loop, got %d flushed samples", got)
	}
}

func TestCollectorStopIsNonBlockingDuringFlush(t *testing.T) {
	collector := NewCollector()
	collector.flushInterval = 10 * time.Millisecond
	blocker := newBlockingMetricCollector()
	collector.RegisterCollector(blocker)
	collector.Record(MetricSample{Name: "boot"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	collector.Start(ctx)
	waitForChannel(t, blocker.entered, time.Second)

	stopped := make(chan struct{})
	go func() {
		collector.Stop()
		close(stopped)
	}()
	waitForChannel(t, stopped, 100*time.Millisecond)

	close(blocker.release)
	waitForCollectorStopped(t, collector)
}

func TestCollectorCanRestartAfterStop(t *testing.T) {
	collector := NewCollector()
	collector.flushInterval = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	collector.Start(ctx)
	collector.Stop()
	waitForCollectorStopped(t, collector)

	collector.Record(MetricSample{Name: "restart"})
	collector.Start(ctx)
	waitForCondition(t, time.Second, func() bool {
		return collector.Stats().FlushedSamples == 1
	})

	collector.Stop()
	waitForCollectorStopped(t, collector)
}
