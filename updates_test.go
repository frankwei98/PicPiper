package main

import (
	"sync"
	"testing"
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
	u.queues = map[string]bool{"optimize": true}
	if u.prepareQuit(false, false) {
		t.Fatal("quit interrupted batch between requests")
	}
	u.queues["optimize"] = false
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
