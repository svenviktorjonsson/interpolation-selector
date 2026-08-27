export function createDomElement(documentRef, tag, props = {}, children = []) {
  const node = documentRef.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === 'boolean' && key in node) {
      node[key] = value;
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) node.append(child);
  return node;
}
