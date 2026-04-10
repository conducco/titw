export class ClickUpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'ClickUpError'
  }
}

export class ClickUpClient {
  private readonly baseUrl = 'https://api.clickup.com/api/v2'

  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: this.token,
      'Content-Type': 'application/json',
    }
  }

  private async handleError(response: Response): Promise<never> {
    let message = `ClickUp API error ${response.status}`
    let code: string | undefined
    try {
      const body = (await response.json()) as { err?: string; ECODE?: string }
      if (body.err) message = body.err
      if (body.ECODE) code = body.ECODE
    } catch {
      // ignore parse failure — use default message
    }
    throw new ClickUpError(response.status, message, code)
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    })
    if (!response.ok) await this.handleError(response)
    return response.json() as Promise<T>
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!response.ok) await this.handleError(response)
    return response.json() as Promise<T>
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!response.ok) await this.handleError(response)
    return response.json() as Promise<T>
  }

  async delete(path: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!response.ok) await this.handleError(response)
  }

  async postFormData<T>(path: string, formData: FormData): Promise<T> {
    // Do NOT set Content-Type — fetch sets it with the multipart boundary automatically
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: this.token },
      body: formData,
    })
    if (!response.ok) await this.handleError(response)
    return response.json() as Promise<T>
  }
}
