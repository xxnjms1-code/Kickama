package analytics

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestCollectorStartIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := NewCollector()
	c.Start(ctx)
	waitForCollectorRunning(t, c)
	firstStopCh := c.stopCh

	for range 10 {
		c.Start(ctx)
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.running {
		t.Fatal("collector should still be running after repeated Start calls")
	}
	if c.stopping {
		t.Fatal("collector should not be stopping after repeated Start calls")
	}
	if c.stopCh != firstStopCh {
		t.Fatal("repeated Start replaced the active flush loop stop channel")
	}
}

func TestCollectorConcurrentStartIsRaceSafeAndSingleLoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := NewCollector()
	var wg sync.WaitGroup
	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Start(ctx)
		}()
	}
	wg.Wait()
	waitForCollectorRunning(t, c)

	c.mu.RLock()
	firstStopCh := c.stopCh
	c.mu.RUnlock()

	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Start(ctx)
		}()
	}
	wg.Wait()

	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.running {
		t.Fatal("collector should be running after concurrent Start calls")
	}
	if c.stopping {
		t.Fatal("collector should not be stopping after concurrent Start calls")
	}
	if c.stopCh != firstStopCh {
		t.Fatal("concurrent Start calls created a second flush loop")
	}
}

func TestCollectorStopIsNonBlockingAndIdempotent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := NewCollector()
	c.Start(ctx)
	waitForCollectorRunning(t, c)

	done := make(chan struct{})
	go func() {
		c.Stop()
		c.Stop()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Stop should not block")
	}

	waitForCollectorStopped(t, c)
}

func TestCollectorCanRestartAfterCleanStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := NewCollector()
	c.Start(ctx)
	waitForCollectorRunning(t, c)

	c.mu.RLock()
	firstStopCh := c.stopCh
	c.mu.RUnlock()

	c.Stop()
	waitForCollectorStopped(t, c)

	c.Start(ctx)
	waitForCollectorRunning(t, c)

	c.mu.RLock()
	restartedStopCh := c.stopCh
	c.mu.RUnlock()
	if restartedStopCh == firstStopCh {
		t.Fatal("restart reused the previous stop channel")
	}

	c.Stop()
	waitForCollectorStopped(t, c)
}

func waitForCollectorRunning(t *testing.T, c *Collector) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		c.mu.RLock()
		running := c.running
		stopping := c.stopping
		c.mu.RUnlock()
		if running && !stopping {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("collector did not enter running state")
}

func waitForCollectorStopped(t *testing.T, c *Collector) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		c.mu.RLock()
		running := c.running
		stopping := c.stopping
		c.mu.RUnlock()
		if !running && !stopping {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("collector did not enter stopped state")
}
