export class Credentials {
  async authenticate() {

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
