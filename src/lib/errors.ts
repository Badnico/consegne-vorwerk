/** Errori di dominio con codice stabile e status HTTP. */
export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export const slotFull = () => new DomainError('slot_full', 'Lo slot si è appena riempito. Scegline un altro.');
export const notFound = (what = 'Risorsa') => new DomainError('not_found', `${what} non trovata.`, 404);
export const invalidState = (from: string, action: string) =>
  new DomainError('invalid_state', `Azione "${action}" non possibile con la consegna nello stato "${from}".`);
export const linkExpired = () => new DomainError('link_expired', 'Il link è scaduto o non è valido.', 410);
