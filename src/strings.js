/**
 * Строковые утилиты демо-проекта. Конвейер agentflow дописывает сюда функции
 * по тестовым задачам из tasks/.
 */

/**
 * Делает первую букву строки заглавной.
 * @param {string} text
 * @returns {string}
 */
export function capitalize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('capitalize: ожидается строка');
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
