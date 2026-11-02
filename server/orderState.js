export function claimCapture(order){return order?.status==='RESERVED'&&!order.reservationReleased?{...order,status:'CAPTURE_PROCESSING'}:null}
export function mayReleaseReservation(order){return order?.status==='RESERVED'&&!order.reservationReleased}
export function mayFinalizeCapture(order){return order?.status==='CAPTURE_PROCESSING'&&!order.reservationReleased}
