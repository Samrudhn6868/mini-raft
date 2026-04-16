# Manual Testing Checklist

## Multi-user drawing
- [ ] Start the gateway, replicas, and frontend.
- [ ] Open the app in at least 3 browser windows.
- [ ] Join the same room from all clients.
- [ ] Draw on one client and confirm the stroke appears on every other client.
- [ ] Repeat with different brush sizes and colors.

## Killing the leader
- [ ] Identify the current leader from `/log-state` or the test suite output.
- [ ] Stop only the leader process.
- [ ] Confirm the remaining replicas are still reachable.
- [ ] Confirm connected browser clients do not disconnect.

## Automatic failover
- [ ] Wait for a new leader to be elected.
- [ ] Confirm the new leader appears within the expected timeout.
- [ ] Draw again after failover.
- [ ] Confirm all clients still receive the stroke.

## Restarting replicas
- [ ] Stop one follower replica.
- [ ] Keep drawing while the follower is offline.
- [ ] Restart that follower on the same port.
- [ ] Confirm it resynchronizes from the leader.
- [ ] Confirm its log length matches the leader.

## Zero-downtime behavior
- [ ] Keep one or more browser clients connected while killing and restarting replicas.
- [ ] Verify the canvas does not reset.
- [ ] Verify in-progress collaboration continues.
- [ ] Confirm no client sees a full disconnect or forced reload.

## No flickering or canvas reset
- [ ] Draw several strokes in sequence.
- [ ] Trigger failover or follower restart.
- [ ] Watch the canvas for redraw flicker or blanking.
- [ ] Confirm the existing drawing remains visible.
- [ ] Confirm new strokes layer on top of the existing canvas state.
