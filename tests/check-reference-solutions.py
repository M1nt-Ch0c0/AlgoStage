"""离线验证所有 Python 题解语法，以及可直接调用的题面示例与随机边界。"""
import ast
import itertools
import json
import random
import re
from pathlib import Path

CONTENT = json.loads(Path('lib/content/generated/hot100-content.json').read_text())
SLUGS = re.findall(r'slug: "([^"]+)"', Path('lib/content/hot100.ts').read_text())
assert set(CONTENT) == set(SLUGS) and len(CONTENT) == 100
FUNCTIONS = {}
for slug, content in CONTENT.items():
    assert len(re.split(r'\n\s*\n', content['statement'])) == 3, slug
    assert {s['language'] for s in content['solutions']} == {'typescript', 'python'}, slug
    source = next(s['code'] for s in content['solutions'] if s['language'] == 'python')
    tree = ast.parse(source)
    namespace = {}
    exec(compile(tree, slug, 'exec'), namespace)
    functions = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
    if functions:
        FUNCTIONS[slug] = namespace[functions[0]]

# 直接使用三段题面中的可 JSON 表达示例；链表和树的节点身份另行验证。
count = 0
for slug, function in FUNCTIONS.items():
    source = next(s['code'] for s in CONTENT[slug]['solutions'] if s['language'] == 'python')
    if re.search(r'\b(?:ListNode|TreeNode|Node)\b', source):
        continue
    example = CONTENT[slug]['statement'].split('**示例**：', 1)[1]
    if ' → ' not in example:
        continue
    raw_args, raw_expected = example.split(' → ', 1)
    try:
        args = json.loads('[' + raw_args + ']')
        expected = json.loads(raw_expected)
    except json.JSONDecodeError:
        continue
    actual = function(*args)
    if actual is None:
        actual = args[0]  # 原地修改类算法的输出是修改后的实参
    if slug in {'group-anagrams', 'subsets', 'permutations', 'combination-sum', 'palindrome-partitioning'}:
        actual = sorted(sorted(part) for part in actual)
        expected = sorted(sorted(part) for part in expected)
    assert actual == expected, (slug, actual, expected)
    count += 1

# 随机对照暴力结果，覆盖重复值、零、负数以及窗口边界。
rng = random.Random(20261012)
for _ in range(100):
    values = [rng.randrange(-4, 5) for _ in range(rng.randrange(1, 9))]
    target = rng.randrange(-6, 7)
    subarrays = [values[i:j] for i in range(len(values)) for j in range(i + 1, len(values) + 1)]
    assert FUNCTIONS['subarray-sum-equals-k'](values, target) == sum(sum(a) == target for a in subarrays)
    assert FUNCTIONS['max-subarray'](values) == max(map(sum, subarrays))
    products = []
    for a in subarrays:
        product = 1
        for x in a:
            product *= x
        products.append(product)
    assert FUNCTIONS['maximum-product-subarray'](values) == max(products)
    k = rng.randrange(1, len(values) + 1)
    assert FUNCTIONS['sliding-window-maximum'](values, k) == [max(values[i:i + k]) for i in range(len(values) - k + 1)]
    assert FUNCTIONS['kth-largest-element-in-an-array'](values, k) == sorted(values, reverse=True)[k - 1]
    missing = next(x for x in range(1, len(values) + 2) if x not in values)
    assert FUNCTIONS['first-missing-positive'](values[:]) == missing
    permutations = sorted(set(itertools.permutations(values)))
    current = tuple(values)
    expected = permutations[(permutations.index(current) + 1) % len(permutations)]
    copy = values[:]
    FUNCTIONS['next-permutation'](copy)
    assert tuple(copy) == expected

print(f'Python 题解：100/100 语法通过；{count} 个题面示例通过；700 个随机对照通过。')
