import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react"
import { attachBlur } from "../../blur/live.ts"
import type { BlurStrength } from "../../blur/mask.ts"

/**
 * Wraps a camera <video>. With blur on, a canvas with the same class sits on
 * top of the video and shows it with the background blurred. The video stays
 * in the page, so it keeps playing and producing frames.
 */
export const BlurredVideo = ({
  videoRef,
  blur,
  className,
  style,
  children
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  /** How strongly to blur, or null for no blur. */
  blur: BlurStrength | null
  /** The class the video uses; the canvas copies it, so both get the same size, shape and mirroring. */
  className?: string
  style?: CSSProperties
  /** The <video> element. */
  children: ReactNode
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!blur || !video || !canvas) return
    return attachBlur(video, canvas, blur)
  }, [blur, videoRef.current])
  return (
    <div className="blurwrap" style={style}>
      {children}
      {blur && <canvas ref={canvasRef} className={className} data-testid="blur-canvas" data-strength={blur} aria-hidden="true" />}
    </div>
  )
}
