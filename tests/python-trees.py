"""默认递归限制下验证 20000 层退化树；节点创建和断言也不依赖递归。"""
import json
from pathlib import Path
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right
content = json.loads(Path('lib/content/generated/hot100-content.json').read_text())
def solution(slug, name):
    namespace = {'TreeNode': TreeNode}
    exec(next(s['code'] for s in content[slug]['solutions'] if s['language'] == 'python'), namespace)
    return namespace[name]
def chain(size, side='right', ones=False):
    nodes = [TreeNode(1 if ones else i) for i in range(size)]
    for a, b in zip(nodes, nodes[1:]): setattr(a, side, b)
    return nodes
n = 20000
nodes = chain(n)
root = nodes[0]
assert solution('maximum-depth-of-binary-tree','maxDepth')(root) == n
assert solution('binary-tree-inorder-traversal','inorderTraversal')(root) == list(range(n))
assert solution('diameter-of-binary-tree','diameterOfBinaryTree')(root) == n-1
assert solution('binary-tree-level-order-traversal','levelOrder')(root) == [[i] for i in range(n)]
assert solution('validate-binary-search-tree','isValidBST')(root)
assert solution('kth-smallest-element-in-a-bst','kthSmallest')(root,n) == n-1
assert solution('binary-tree-right-side-view','rightSideView')(root) == list(range(n))
assert solution('lowest-common-ancestor-of-a-binary-tree','lowestCommonAncestor')(root,nodes[1000],nodes[-1]) is nodes[1000]
invert = solution('invert-binary-tree','invertTree')
invert(root)
assert root.left is nodes[1] and nodes[-2].left is nodes[-1]
invert(root)
left,right = chain(n,'left',True),chain(n,'right',True)
symmetric = TreeNode(0,left[0],right[0])
check = solution('symmetric-tree','isSymmetric')
assert check(symmetric)
right[-1].val = 2
assert not check(symmetric)
ones = chain(n,ones=True)[0]
assert solution('path-sum-iii','pathSum')(ones,3) == n-2
assert solution('binary-tree-maximum-path-sum','maxPathSum')(ones) == n
built = solution('construct-binary-tree-from-preorder-and-inorder-traversal','buildTree')(list(range(n)),list(range(n)))
assert solution('maximum-depth-of-binary-tree','maxDepth')(built) == n
balanced = solution('sorted-array-to-binary-search-tree','sortedArrayToBST')(list(range(n)))
assert solution('validate-binary-search-tree','isValidBST')(balanced)
assert solution('maximum-depth-of-binary-tree','maxDepth')(balanced) <= 16
flat = chain(n,'left')[0]
solution('flatten-binary-tree-to-linked-list','flatten')(flat)
for i in range(n):
    assert flat.val == i and flat.left is None
    flat = flat.right
assert flat is None
# 分叉、负值、空树与重建左右顺序，防止仅在退化树上正确。
assert solution('path-sum-iii','pathSum')(TreeNode(1,TreeNode(-1),TreeNode(1)),1) == 2
assert solution('binary-tree-maximum-path-sum','maxPathSum')(TreeNode(-10,TreeNode(9),TreeNode(20,TreeNode(15),TreeNode(7)))) == 42
assert solution('maximum-depth-of-binary-tree','maxDepth')(None) == 0
built = solution('construct-binary-tree-from-preorder-and-inorder-traversal','buildTree')([3,9,20,15,7],[9,3,15,20,7])
assert solution('binary-tree-level-order-traversal','levelOrder')(built) == [[3],[9,20],[15,7]]
print('15 道 Python 树题：20000 层退化树及分叉边界通过，无递归调用。')
