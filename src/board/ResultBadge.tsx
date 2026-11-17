import { RESULT_ICON, RESULT_LABEL } from '../lib/board/view';
import type { CardResult } from '../lib/board/view';
import { badgeClass, resultTextClass } from '../app/styles';

/** The validation badge: a symbol and a word, in the result's colour. */
export function ResultBadge({ result }: { result: CardResult }) {
  return (
    <span className={`${badgeClass} ${resultTextClass[result]}`}>
      <span aria-hidden="true">{RESULT_ICON[result]}</span>
      {RESULT_LABEL[result]}
    </span>
  );
}
