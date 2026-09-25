// Pure state machine for the "Donation Integrity" ledger + certificate panel, kept separate from the React
// component so its loading/success/error transitions are testable without rendering (project convention).

export const initialState = {
  ledgerStatus: 'idle', // idle | loading | ready | error
  ledger: null,
  ledgerError: '',
  certificateStatus: 'idle', // idle | loading | ready | error
  certificate: null,
  certificateError: '',
};

export function donationIntegrityReducer(state, action) {
  switch (action.type) {
    case 'LEDGER_LOADING':
      return { ...state, ledgerStatus: 'loading', ledgerError: '' };
    case 'LEDGER_SUCCESS':
      return { ...state, ledgerStatus: 'ready', ledger: action.data, ledgerError: '' };
    case 'LEDGER_ERROR':
      return { ...state, ledgerStatus: 'error', ledger: null, ledgerError: action.message };
    case 'CERTIFICATE_LOADING':
      return { ...state, certificateStatus: 'loading', certificateError: '' };
    case 'CERTIFICATE_SUCCESS':
      return { ...state, certificateStatus: 'ready', certificate: action.data, certificateError: '' };
    case 'CERTIFICATE_ERROR':
      return { ...state, certificateStatus: 'error', certificate: null, certificateError: action.message };
    default:
      return state;
  }
}
