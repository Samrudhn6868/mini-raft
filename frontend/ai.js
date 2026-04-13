function linePoints(startX, startY, endX, endY, steps = 14) {
  const points = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    points.push({
      x: startX + (endX - startX) * t,
      y: startY + (endY - startY) * t
    })
  }
  return points
}

function circlePoints(cx, cy, radius, segments = 28) {
  const points = []
  for (let i = 0; i <= segments; i++) {
    const theta = (Math.PI * 2 * i) / segments
    points.push({
      x: cx + Math.cos(theta) * radius,
      y: cy + Math.sin(theta) * radius
    })
  }
  return points
}

function toStroke(points, style) {
  return {
    type: "stroke",
    points,
    color: style.color,
    size: style.size
  }
}

function drawHouse(origin, style) {
  const { x, y } = origin
  return [
    toStroke(linePoints(x, y, x + 180, y), style),
    toStroke(linePoints(x + 180, y, x + 180, y + 110), style),
    toStroke(linePoints(x + 180, y + 110, x, y + 110), style),
    toStroke(linePoints(x, y + 110, x, y), style),
    toStroke(linePoints(x - 10, y, x + 90, y - 70), style),
    toStroke(linePoints(x + 90, y - 70, x + 190, y), style)
  ]
}

function drawTree(origin, style) {
  const { x, y } = origin
  return [
    toStroke(linePoints(x + 55, y + 160, x + 55, y + 80), style),
    toStroke(linePoints(x + 85, y + 160, x + 85, y + 80), style),
    toStroke(linePoints(x + 55, y + 160, x + 85, y + 160), style),
    toStroke(circlePoints(x + 70, y + 60, 48, 26), style)
  ]
}

function drawSun(origin, style) {
  const { x, y } = origin
  return [
    toStroke(circlePoints(x + 60, y + 60, 34, 24), style),
    toStroke(linePoints(x + 60, y, x + 60, y - 28), style),
    toStroke(linePoints(x + 60, y + 120, x + 60, y + 148), style),
    toStroke(linePoints(x, y + 60, x - 28, y + 60), style),
    toStroke(linePoints(x + 120, y + 60, x + 148, y + 60), style)
  ]
}

export function generateAIDrawing(prompt, options = {}) {
  const text = String(prompt || "").toLowerCase()
  const origin = {
    x: options.originX || 240,
    y: options.originY || 230
  }
  const style = {
    color: options.color || "#fef08a",
    size: options.size || 3
  }

  if (text.includes("house")) return drawHouse(origin, style)
  if (text.includes("tree")) return drawTree(origin, style)
  if (text.includes("sun")) return drawSun(origin, style)

  return [toStroke(circlePoints(origin.x + 70, origin.y + 70, 44, 28), style)]
}
