import { dialog } from './discreteApi';
import i18n from '../i18n';

export function confirmOperation(title: string, object: string, scope: string, count = 1): Promise<boolean> {
  return new Promise(resolve => {
    dialog.warning({ title, content: `${scope}\n${object} (${count})`, positiveText: i18n.global.t('common.delete'), negativeText: i18n.global.t('common.cancel'),
      onPositiveClick: () => resolve(true), onNegativeClick: () => resolve(false), onClose: () => resolve(false),
    });
  });
}
