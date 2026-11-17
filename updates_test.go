package main

import (
	"sync"
	"testing"
	"time"
)

func TestPreparedUpdateWaitsForTasks(t *testing.T) {
	u := &updateController{installed: true}
	done, err := u.begin()
	if err != nil {
		t.Fatal(err)
	}
	if u.prepareQuit(false, false) {
		t.Fatal("quit interrupted active request")
	}
	done()
	u.queues = map[string]time.Time{"optimize": time.Now().Add(activityLeaseDuration)}
	if u.prepareQuit(false, false) {
		t.Fatal("quit interrupted batch between requests")
	}
	delete(u.queues, "optimize")
	if u.prepareQuit(true, false) {
		t.Fatal("quit interrupted Mini")
	}
	if !u.prepareQuit(false, false) {
		t.Fatal("idle update could not quit")
	}
	if _, err := u.begin(); err == nil {
		t.Fatal("work accepted during quit")
	}
}

func TestQuitWithoutUpdateAndSystemShutdown(t *testing.T) {
	for _, installed := range []bool{false, true} {
		u := &updateController{installed: installed}
		if !u.prepareQuit(true, installed) {
			t.Fatal("normal quit or shutdown prevented")
		}
	}
}

func TestUpdateActivityConcurrent(t *testing.T) {
	u := &updateController{installed: true}
	var workers sync.WaitGroup
	for range 30 {
		workers.Go(func() {
			done, err := u.begin()
			if err != nil {
				t.Error(err)
				return
			}
			defer done()
			if u.prepareQuit(false, false) {
				t.Error("active work allowed quit")
			}
		})
	}
	workers.Wait()
	if !u.prepareQuit(false, false) {
		t.Fatal("request count leaked")
	}
}

func TestUploadLeasesSurviveNavigationAndIndependentBatches(t *testing.T) {
	u := &updateController{installed: true}
	activity := func(payload string) {
		t.Helper()
		if _, err := u.call("update_activity", []byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	activity(`{"scope":"gallery","id":"first","busy":true}`)
	activity(`{"scope":"gallery","id":"second","busy":true}`)
	activity(`{"scope":"gallery","id":"first","busy":false}`)
	if u.prepareQuit(false, false) {
		t.Fatal("one completed batch released another batch's lease")
	}
	activity(`{"scope":"gallery","id":"second","busy":false}`)
	if !u.prepareQuit(false, false) {
		t.Fatal("completed batches retained a lease")
	}
	if _, err := u.call("update_activity", []byte(`{"scope":"gallery","id":"third","busy":true}`)); err == nil {
		t.Fatal("batch started during quit")
	}
}

func TestExpiredActivityLeaseDoesNotBlockRestart(t *testing.T) {
	now := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	u := &updateController{installed: true, now: func() time.Time { return now }}
	if _, err := u.call("update_activity", []byte(`{"scope":"gallery","id":"old-page","busy":true}`)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(activityLeaseDuration + time.Second)
	if !u.prepareQuit(false, false) {
		t.Fatal("expired page lease permanently blocked restart")
	}
}

func TestActivityHeartbeatAndRunningRequestsKeepRestartDeferred(t *testing.T) {
	now := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	u := &updateController{installed: true, now: func() time.Time { return now }}
	payload := []byte(`{"scope":"gallery","id":"live-page","busy":true}`)
	if _, err := u.call("update_activity", payload); err != nil {
		t.Fatal(err)
	}
	now = now.Add(activityLeaseDuration / 2)
	if _, err := u.call("update_activity", payload); err != nil {
		t.Fatal(err)
	}
	now = now.Add(activityLeaseDuration/2 + time.Second)
	if u.prepareQuit(false, false) {
		t.Fatal("renewed lease allowed restart")
	}
	done, err := u.begin()
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(activityLeaseDuration + time.Second)
	if u.prepareQuit(false, false) {
		t.Fatal("long running request was interrupted after lease expiry")
	}
	done()
	if !u.prepareQuit(false, false) {
		t.Fatal("completed request left restart blocked")
	}
}
