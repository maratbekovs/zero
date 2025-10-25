// routes/middlewares.js
function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ message: 'Требуется авторизация.' });
}

function isModeratorOrAdmin(req, res, next) {
  if (
    req.session &&
    req.session.userId &&
    (req.session.userRole === 'moderator' || req.session.userRole === 'admin')
  ) {
    return next();
  }
  return res.status(403).json({ message: 'Доступ запрещён. Требуется роль модератора/администратора.' });
}

function isAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.userRole === 'admin') return next();
  return res.status(403).json({ message: 'Доступ запрещён. Требуется роль администратора.' });
}

module.exports = {
  isAuthenticated,
  isModeratorOrAdmin,
  isAdmin,
};