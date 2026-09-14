'use strict';

// Paystack's local card fee as the platform passes it on to riders: 2.9% + R1,
// added on top of the rental. One definition, because the rider checkout, the
// payment verifier and the charge review queue must all agree on it.
function calcPaystackFee(amountZAR) {
  return +(amountZAR * 0.029 + 1).toFixed(2);
}

function calcGrossAmount(amountZAR) {
  const fee = calcPaystackFee(amountZAR);
  return +(amountZAR + fee).toFixed(2);
}

module.exports = { calcPaystackFee, calcGrossAmount };
