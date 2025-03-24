export class Credentials {
  async authenticate() {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  get workspace() {
    return process.env.BL_WORKSPACE || '';
  }

  get authorization() {
    return ''
  }

  get token() {
    return ''
  }
}
