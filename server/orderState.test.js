import test from 'node:test';import assert from 'node:assert/strict';import{claimCapture,mayFinalizeCapture,mayReleaseReservation}from'./orderState.js';
test('capture claim wins over cancellation and expiration',()=>{const processing=claimCapture({status:'RESERVED',reservationReleased:false});assert.equal(processing.status,'CAPTURE_PROCESSING');assert.equal(mayReleaseReservation(processing),false)});
test('only one concurrent capture claim can succeed',()=>{const first=claimCapture({status:'RESERVED',reservationReleased:false});assert.equal(claimCapture(first),null)});
test('successful capture cannot finalize after reservation release',()=>assert.equal(mayFinalizeCapture({status:'CAPTURE_PROCESSING',reservationReleased:true}),false));
test('released reservation cannot be claimed or released twice',()=>{const released={status:'CANCELLED',reservationReleased:true};assert.equal(claimCapture(released),null);assert.equal(mayReleaseReservation(released),false)});
