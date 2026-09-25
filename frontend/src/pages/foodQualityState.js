// Pure state machine for the Food Quality Check upload flow, kept separate from FoodQualityCheck.jsx so the
// upload/loading/result/unknown/error transitions are testable without rendering React (see project convention:
// no React Testing Library/jsdom - pure logic modules tested with node:test).

export const initialState = {
  fileError: '',
  fileName: '',
  hasValidFile: false,
  submitStatus: 'idle', // idle | loading | success | error
  result: null,
  error: '',
};

export function foodQualityReducer(state, action) {
  switch (action.type) {
    case 'FILE_INVALID':
      return { ...initialState, fileError: action.message };
    case 'FILE_VALID':
      return { ...initialState, fileName: action.fileName, hasValidFile: true };
    case 'CLEAR':
      return initialState;
    case 'SUBMIT_START':
      return { ...state, submitStatus: 'loading', error: '', result: null };
    case 'SUBMIT_SUCCESS':
      return { ...state, submitStatus: 'success', result: action.data, error: '' };
    case 'SUBMIT_ERROR':
      return { ...state, submitStatus: 'error', error: action.message, result: null };
    default:
      return state;
  }
}
